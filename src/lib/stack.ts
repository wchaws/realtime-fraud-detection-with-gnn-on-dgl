import { GatewayVpcEndpointAwsService, Vpc, FlowLogDestination, SubnetType, IVpc } from '@aws-cdk/aws-ec2';
import { Role, ServicePrincipal, PolicyDocument, PolicyStatement } from '@aws-cdk/aws-iam';
import { ClusterParameterGroup, ParameterGroup, DatabaseCluster, InstanceType, IDatabaseCluster, CfnDBInstance } from '@aws-cdk/aws-neptune';
import { Bucket, BucketEncryption, IBucket } from '@aws-cdk/aws-s3';
import { Queue, QueueEncryption } from '@aws-cdk/aws-sqs';
import { Construct, RemovalPolicy, Stack, StackProps, Duration, CfnParameter } from '@aws-cdk/core';
import * as pjson from '../../package.json';
import { TransactionDashboardStack } from './dashboard-stack';
import { InferenceStack } from './inference-stack';
import { TrainingStack } from './training-stack';

export class FraudDetectionStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const vpcId = this.node.tryGetContext('vpcId');
    const vpc = vpcId ? Vpc.fromLookup(this, 'FraudDetectionVpc', {
      vpcId: vpcId === 'default' ? undefined : vpcId,
      isDefault: vpcId === 'default' ? true : undefined,
    }) : (() => {
      const newVpc = new Vpc(this, 'FraudDetectionVpc', {
        maxAzs: 2,
        gatewayEndpoints: {
          s3: {
            service: GatewayVpcEndpointAwsService.S3,
          },
          dynamodb: {
            service: GatewayVpcEndpointAwsService.DYNAMODB,
          },
        },
      });
      newVpc.addFlowLog('VpcFlowlogs', {
        destination: FlowLogDestination.toS3(),
      });
      return newVpc;
    })();
    if (vpc.privateSubnets.length < 1) {
      throw new Error('The VPC must have PRIVATE subnet.');
    }

    const accessLogBucket = new Bucket(this, 'BucketAccessLog', {
      encryption: BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsPrefix: 'accessLogBucketAccessLog',
    });

    const bucket = new Bucket(this, 'FraudDetectionDataBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      serverAccessLogsBucket: accessLogBucket,
      serverAccessLogsPrefix: 'dataBucketAccessLog',
    });

    const neptuneInstanceType = new CfnParameter(this, 'NeptuneInstaneType', {
      description: 'Instance type of graph database Neptune',
      type: 'String',
      allowedValues: [
        'db.r5.xlarge',
        'db.r5.2xlarge',
        'db.r5.4xlarge',
        'db.r5.8xlarge',
        'db.r5.12xlarge',
      ],
      default: 'db.r5.8xlarge',
    });

    const dataPrefix = 'fraud-detection/';
    const replicaCount = this.node.tryGetContext('NeptuneReplicaCount');
    const neptuneInfo = this._createGraphDB_Neptune(vpc, bucket, dataPrefix,
      neptuneInstanceType.valueAsString,
      (replicaCount === undefined) ? 1 : parseInt(replicaCount),
    );

    const dataColumnsArg = {
      id_cols: 'card1,card2,card3,card4,card5,card6,ProductCD,addr1,addr2,P_emaildomain,R_emaildomain',
      cat_cols: 'M1,M2,M3,M4,M5,M6,M7,M8,M9',
      dummies_cols: 'M1_F,M1_T,M2_F,M2_T,M3_F,M3_T,M4_M0,M4_M1,M4_M2,M5_F,M5_T,M6_F,M6_T,M7_F,M7_T,M8_F,M8_T,M9_F,M9_T',
    };

    const trainingStack = new TrainingStack(this, 'training', {
      vpc,
      bucket,
      accessLogBucket,
      neptune: neptuneInfo,
      dataPrefix,
      dataColumnsArg: dataColumnsArg,
    });

    neptuneInfo.cluster.connections.allowDefaultPortFrom(trainingStack.glueJobSG, 'access from glue job.');
    neptuneInfo.cluster.connections.allowDefaultPortFrom(trainingStack.loadPropsSG, 'access from load props fargate task.');

    const tranQueue = new Queue(this, 'TransQueue', {
      contentBasedDeduplication: true,
      encryption: QueueEncryption.KMS_MANAGED,
      fifo: true,
      removalPolicy: RemovalPolicy.DESTROY,
      visibilityTimeout: Duration.seconds(60),
      deadLetterQueue: {
        queue: new Queue(this, 'TransDLQ', {
          contentBasedDeduplication: true,
          encryption: QueueEncryption.KMS_MANAGED,
          fifo: true,
          visibilityTimeout: Duration.seconds(60),
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        maxReceiveCount: 5,
      },
    });

    const inferenceStack = new InferenceStack(this, 'inference', {
      vpc,
      neptune: neptuneInfo.cluster,
      queue: tranQueue,
      sagemakerEndpointName: trainingStack.endpointName,
      dataColumnsArg: dataColumnsArg,
    });

    neptuneInfo.cluster.connections.allowDefaultPortFrom(inferenceStack.inferenceSG, 'access from inference job.');

    const inferenceFnArn = inferenceStack.inferenceFn.functionArn;
    const interParameterGroups = [
      {
        Label: { default: 'The configuration of graph database Neptune' },
        Parameters: [neptuneInstanceType.logicalId],
      },
    ];

    let customDomain: string | undefined;
    let r53HostZoneId: string | undefined;
    if ('aws-cn' === this.node.tryGetContext('TargetPartition') ||
      (/true/i).test(this.node.tryGetContext('EnableDashboardCustomDomain'))) {
      const dashboardDomainNamePara = new CfnParameter(this, 'DashboardDomain', {
        description: 'Custom domain name for dashboard',
        type: 'String',
        allowedPattern: '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]',
      });
      const r53HostZoneIdPara = new CfnParameter(this, 'Route53HostedZoneId', {
        type: 'AWS::Route53::HostedZone::Id',
        description: 'Route53 public hosted zone ID of given domain',
      });
      interParameterGroups.push({
        Label: { default: 'The dashboard configuration' },
        Parameters: [dashboardDomainNamePara.logicalId, r53HostZoneIdPara.logicalId],
      });
      customDomain = dashboardDomainNamePara.valueAsString;
      r53HostZoneId = r53HostZoneIdPara.valueAsString;
    }

    new TransactionDashboardStack(this, 'dashboard', {
      vpc,
      queue: tranQueue,
      inferenceArn: inferenceFnArn,
      accessLogBucket,
      customDomain: customDomain,
      r53HostZoneId: r53HostZoneId,
    });

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: interParameterGroups,
      },
    };
    this.templateOptions.description = `(SO8013) - Real-time Fraud Detection with Graph Neural Network on DGL. Template version ${pjson.version}`;
  }

  private _createGraphDB_Neptune(vpc: IVpc, bucket: IBucket, dataPrefix: string, instanceType: string, replicaCount: number): {
    cluster: IDatabaseCluster;
    loadObjectPrefix: string;
    loadRole: string;
  } {
    const clusterPort = 8182;
    const clusterParams = new ClusterParameterGroup(this, 'ClusterParams', {
      description: 'Cluster parameter group',
      parameters: {
        neptune_enable_audit_log: '1',
        neptune_streams: '1',
      },
    });

    const dbParams = new ParameterGroup(this, 'DBParamGroup', {
      description: 'Neptune DB Param Group',
      parameters: {
        neptune_query_timeout: '600000',
      },
    });

    const neptuneRole = new Role(this, 'NeptuneBulkLoadRole', {
      assumedBy: new ServicePrincipal('rds.amazonaws.com'),
      inlinePolicies: {
        kms: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: [
                'kms:Decrypt',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    });
    const neptuneLoadObjectPrefix = `${dataPrefix}neptune/bulk-load`;
    bucket.grantRead(neptuneRole, `${neptuneLoadObjectPrefix}/*`);

    const graphDBCluster = new DatabaseCluster(this, 'TransactionGraphCluster', {
      vpc,
      instanceType: InstanceType.of(instanceType),
      clusterParameterGroup: clusterParams,
      parameterGroup: dbParams,
      associatedRoles: [neptuneRole],
      iamAuthentication: true,
      storageEncrypted: true,
      port: clusterPort,
      vpcSubnets: {
        subnetType: SubnetType.PRIVATE,
      },
      instances: 1 + replicaCount,
      removalPolicy: RemovalPolicy.DESTROY,
      backupRetention: Duration.days(7),
    });
    graphDBCluster.node.findAll().filter(c => (c as CfnDBInstance).cfnOptions)
      .forEach(c => (c as CfnDBInstance).autoMinorVersionUpgrade = true);

    return {
      cluster: graphDBCluster,
      loadObjectPrefix: neptuneLoadObjectPrefix,
      loadRole: neptuneRole.roleArn,
    };
  }
}