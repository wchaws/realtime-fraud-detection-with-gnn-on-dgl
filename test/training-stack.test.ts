import * as path from 'path';
import '@aws-cdk/assert/jest';
import { ResourcePart } from '@aws-cdk/assert/lib/assertions/have-resource';
import { Vpc } from '@aws-cdk/aws-ec2';
import { DatabaseCluster, InstanceType } from '@aws-cdk/aws-neptune';

import { Bucket } from '@aws-cdk/aws-s3';
import { App, Stack } from '@aws-cdk/core';
import { TrainingStack } from '../src/lib/training-stack';
import { artifactHash, dirArtifactHash } from '../src/lib/utils';

describe('training stack test suite', () => {
  let stack: TrainingStack;

  let scriptHash : string;
  let neptuneLibHash : string;
  let codeDirHash: string;

  beforeAll(() => {
    scriptHash = artifactHash(path.join(__dirname, '../src/scripts/glue-etl.py'));
    neptuneLibHash = artifactHash(path.join(__dirname, '../src/script-libs/amazon-neptune-tools/neptune-python-utils/target/neptune_python_utils.zip'));
    codeDirHash = dirArtifactHash(path.join(__dirname, '../src/sagemaker/FD_SL_DGL/code'));
    ({ stack } = initializeStackWithContextsAndEnvs({}));
  });

  beforeEach(() => {
  });

  test('data ingest lambda is created.', () => {
    expect(stack).toHaveResourceLike('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: [
              'xray:PutTraceSegments',
              'xray:PutTelemetryRecords',
            ],
            Effect: 'Allow',
            Resource: '*',
          },
          {
            Action: [
              's3:DeleteObject*',
              's3:PutObject*',
              's3:Abort*',
            ],
            Effect: 'Allow',
            Resource: [
              {
                Ref: 'referencetoTestStackBucket80A092C2Arn',
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      Ref: 'referencetoTestStackBucket80A092C2Arn',
                    },
                    '/*',
                  ],
                ],
              },
            ],
          },
        ],
        Version: '2012-10-17',
      },
      Roles: [
        {
          Ref: 'DataIngestFuncServiceRole170D0DE1',
        },
      ],
    });

    expect(stack).toHaveResourceLike('AWS::Lambda::LayerVersion', {
      CompatibleRuntimes: [
        'python3.8',
      ],
    });

    expect(stack).toHaveResourceLike('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          TargetBucket: {
            Ref: 'referencetoTestStackBucket80A092C2Ref',
          },
          TransactionPrefix: 'fraud-detection/transactions',
          IdentityPrefix: 'fraud-detection/identity',
          DATASET_URL: {
            'Fn::FindInMap': [
              'DataSet',
              {
                Ref: 'AWS::Partition',
              },
              'ieee',
            ],
          },
        },
      },
      Handler: 'import.handler',
      Layers: [
        {
          Ref: 'DataIngestLayer10CACF9D',
        },
      ],
      MemorySize: 3008,
      Runtime: 'python3.8',
      Timeout: 900,
      TracingConfig: {
        Mode: 'Active',
      },
    });
  });

  test('glue connection is created.', () => {
    expect(stack).toHaveResourceLike('AWS::Glue::Connection', {
      ConnectionInput: {
        ConnectionProperties: {},
        ConnectionType: 'NETWORK',
        PhysicalConnectionRequirements: {
          AvailabilityZone: {
            'Fn::Select': [
              0,
              {
                'Fn::GetAZs': '',
              },
            ],
          },
          SecurityGroupIdList: [
            {
              'Fn::GetAtt': [
                'ETLCompGlueJobSG4513B7C4',
                'GroupId',
              ],
            },
          ],
          SubnetId: {
            Ref: 'referencetoTestStackVpcPrivateSubnet1Subnet707BB947Ref',
          },
        },
      },
    });

    expect(stack).toCountResources('AWS::Glue::Connection', 2);
  });

  test('glue security configuration is created.', () => {
    expect(stack).toHaveResourceLike('AWS::Glue::SecurityConfiguration', {
      EncryptionConfiguration: {
        CloudWatchEncryption: {
          CloudWatchEncryptionMode: 'SSE-KMS',
          KmsKeyArn: {
            'Fn::GetAtt': [
              'ETLCompFraudDetectionSecConfKey781FDC27',
              'Arn',
            ],
          },
        },
        JobBookmarksEncryption: {
          JobBookmarksEncryptionMode: 'CSE-KMS',
          KmsKeyArn: {
            'Fn::GetAtt': [
              'ETLCompFraudDetectionSecConfKey781FDC27',
              'Arn',
            ],
          },
        },
        S3Encryptions: [
          {
            S3EncryptionMode: 'SSE-S3',
          },
        ],
      },
      Name: {
        'Fn::Join': [
          '',
          [
            'SecConf-',
            {
              Ref: 'AWS::StackName',
            },
          ],
        ],
      },
    });

    // check custom KMS key grant logs to encrypt
    expect(stack).toHaveResourceLike('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: [
          {
            Action: [
              'kms:Create*',
              'kms:Describe*',
              'kms:Enable*',
              'kms:List*',
              'kms:Put*',
              'kms:Update*',
              'kms:Revoke*',
              'kms:Disable*',
              'kms:Get*',
              'kms:Delete*',
              'kms:ScheduleKeyDeletion',
              'kms:CancelKeyDeletion',
              'kms:GenerateDataKey',
              'kms:TagResource',
              'kms:UntagResource',
            ],
            Effect: 'Allow',
            Principal: {
              AWS: {
                'Fn::Join': [
                  '',
                  [
                    'arn:',
                    {
                      Ref: 'AWS::Partition',
                    },
                    ':iam::',
                    {
                      Ref: 'AWS::AccountId',
                    },
                    ':root',
                  ],
                ],
              },
            },
            Resource: '*',
          },
          {
            Action: [
              'kms:Encrypt*',
              'kms:Decrypt*',
              'kms:ReEncrypt*',
              'kms:GenerateDataKey*',
              'kms:Describe*',
            ],
            Condition: {
              ArnLike: {
                'kms:EncryptionContext:aws:logs:arn': {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      {
                        Ref: 'AWS::Partition',
                      },
                      ':logs:',
                      {
                        Ref: 'AWS::Region',
                      },
                      ':',
                      {
                        Ref: 'AWS::AccountId',
                      },
                      ':log-group:/aws-glue/jobs/SecConf-',
                      {
                        Ref: 'AWS::StackName',
                      },
                      '*',
                    ],
                  ],
                },
              },
            },
            Effect: 'Allow',
            Principal: {
              Service: {
                'Fn::Join': [
                  '',
                  [
                    'logs.',
                    {
                      Ref: 'AWS::Region',
                    },
                    '.',
                    {
                      Ref: 'AWS::URLSuffix',
                    },
                  ],
                ],
              },
            },
            Resource: '*',
          },
        ],
      },
    });
  });

  test('glue crawler is created.', () => {
    expect(stack).toHaveResourceLike('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: [
              's3:GetObject*',
              's3:GetBucket*',
              's3:List*',
            ],
            Effect: 'Allow',
            Resource: [
              {
                Ref: 'referencetoTestStackBucket80A092C2Arn',
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      Ref: 'referencetoTestStackBucket80A092C2Arn',
                    },
                    '/fraud-detection/*',
                  ],
                ],
              },
            ],
          },
        ],
        Version: '2012-10-17',
      },
      Roles: [
        {
          Ref: 'ETLCompDataCrawlerRoleE08812C6',
        },
      ],
    });

    expect(stack).toHaveResourceLike('AWS::Glue::Crawler', {
      Targets: {
        CatalogTargets: [
          {
            DatabaseName: {
              Ref: 'ETLCompFraudDetectionDatabaseFC554BB3',
            },
            Tables: [
              {
                Ref: 'ETLCompTransactionTableCFEEAFA7',
              },
              {
                Ref: 'ETLCompIdentityTableA8CCD6A3',
              },
            ],
          },
        ],
      },
      DatabaseName: {
        Ref: 'ETLCompFraudDetectionDatabaseFC554BB3',
      },
      SchemaChangePolicy: {
        DeleteBehavior: 'LOG',
        UpdateBehavior: 'UPDATE_IN_DATABASE',
      },
    });
  });

  test('s3 bucket for glue job', () => {
    expect(stack).toHaveResourceLike('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
      LoggingConfiguration: {
        DestinationBucketName: {
          Ref: 'referencetoTestStackAccessLogF5229892Ref',
        },
        LogFilePrefix: 'glueJobBucketAccessLog',
      },
    });
  });

  test('glue job is created', () => {
    expect(stack).toHaveResourceLike('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: {
              Service: 'glue.amazonaws.com',
            },
          },
        ],
      },
      ManagedPolicyArns: [
        {
          'Fn::Join': [
            '',
            [
              'arn:',
              {
                Ref: 'AWS::Partition',
              },
              ':iam::aws:policy/service-role/AWSGlueServiceRole',
            ],
          ],
        },
      ],
      Policies: [
        {
          PolicyDocument: {
            Statement: [
              {
                Action: 'glue:GetConnection',
                Effect: 'Allow',
                Resource: [
                  {
                    'Fn::Join': [
                      '',
                      [
                        'arn:',
                        {
                          Ref: 'AWS::Partition',
                        },
                        ':glue:',
                        {
                          Ref: 'AWS::Region',
                        },
                        ':',
                        {
                          Ref: 'AWS::AccountId',
                        },
                        ':catalog',
                      ],
                    ],
                  },
                  {
                    'Fn::Join': [
                      '',
                      [
                        'arn:',
                        {
                          Ref: 'AWS::Partition',
                        },
                        ':glue:',
                        {
                          Ref: 'AWS::Region',
                        },
                        ':',
                        {
                          Ref: 'AWS::AccountId',
                        },
                        ':connection/',
                        {
                          Ref: 'ETLCompNetworkConnection1C8EC8091',
                        },
                      ],
                    ],
                  },
                  {
                    'Fn::Join': [
                      '',
                      [
                        'arn:',
                        {
                          Ref: 'AWS::Partition',
                        },
                        ':glue:',
                        {
                          Ref: 'AWS::Region',
                        },
                        ':',
                        {
                          Ref: 'AWS::AccountId',
                        },
                        ':connection/',
                        {
                          Ref: 'ETLCompNetworkConnection25132F300',
                        },
                      ],
                    ],
                  },
                ],
              },
            ],
          },
        },
        {
          PolicyDocument: {
            Statement: [
              {
                Action: 'logs:AssociateKmsKey',
                Effect: 'Allow',
                Resource: {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      {
                        Ref: 'AWS::Partition',
                      },
                      ':logs:',
                      {
                        Ref: 'AWS::Region',
                      },
                      ':',
                      {
                        Ref: 'AWS::AccountId',
                      },
                      ':log-group:/aws-glue/jobs/SecConf-',
                      {
                        Ref: 'AWS::StackName',
                      },
                      '*',
                    ],
                  ],
                },
              },
            ],
          },
          PolicyName: 'logs',
        },

      ],
    });

    expect(stack).toHaveResourceLike('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'neptune-db:*',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  {
                    Ref: 'AWS::Partition',
                  },
                  ':neptune-db:',
                  {
                    Ref: 'AWS::Region',
                  },
                  ':',
                  {
                    Ref: 'AWS::AccountId',
                  },
                  ':',
                  {
                    Ref: 'referencetoTestStackDatabase1EBED910ClusterResourceId',
                  },
                  '/*',
                ],
              ],
            },
          },
          {
            Action: [
              'glue:BatchDeletePartition',
              'glue:BatchGetPartition',
              'glue:GetPartition',
              'glue:GetPartitions',
              'glue:GetTable',
              'glue:GetTables',
              'glue:GetTableVersion',
              'glue:GetTableVersions',
            ],
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  {
                    Ref: 'AWS::Partition',
                  },
                  ':glue:',
                  {
                    Ref: 'AWS::Region',
                  },
                  ':',
                  {
                    Ref: 'AWS::AccountId',
                  },
                  ':table/',
                  {
                    Ref: 'ETLCompFraudDetectionDatabaseFC554BB3',
                  },
                  '/',
                  {
                    Ref: 'ETLCompIdentityTableA8CCD6A3',
                  },
                ],
              ],
            },
          },
          {
            Action: [
              's3:GetObject*',
              's3:GetBucket*',
              's3:List*',
            ],
            Effect: 'Allow',
            Resource: [
              {
                Ref: 'referencetoTestStackBucket80A092C2Arn',
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      Ref: 'referencetoTestStackBucket80A092C2Arn',
                    },
                    '/fraud-detection/identity*',
                  ],
                ],
              },
            ],
          },
          {
            Action: [
              'glue:BatchDeletePartition',
              'glue:BatchGetPartition',
              'glue:GetPartition',
              'glue:GetPartitions',
              'glue:GetTable',
              'glue:GetTables',
              'glue:GetTableVersion',
              'glue:GetTableVersions',
            ],
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  {
                    Ref: 'AWS::Partition',
                  },
                  ':glue:',
                  {
                    Ref: 'AWS::Region',
                  },
                  ':',
                  {
                    Ref: 'AWS::AccountId',
                  },
                  ':table/',
                  {
                    Ref: 'ETLCompFraudDetectionDatabaseFC554BB3',
                  },
                  '/',
                  {
                    Ref: 'ETLCompTransactionTableCFEEAFA7',
                  },
                ],
              ],
            },
          },
          {
            Action: [
              's3:GetObject*',
              's3:GetBucket*',
              's3:List*',
            ],
            Effect: 'Allow',
            Resource: [
              {
                Ref: 'referencetoTestStackBucket80A092C2Arn',
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      Ref: 'referencetoTestStackBucket80A092C2Arn',
                    },
                    '/fraud-detection/transactions*',
                  ],
                ],
              },
            ],
          },
          {
            Action: [
              's3:GetObject*',
              's3:GetBucket*',
              's3:List*',
              's3:DeleteObject*',
              's3:PutObject*',
              's3:Abort*',
            ],
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'ETLCompGlueJobBucketEAA2FE1A',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'ETLCompGlueJobBucketEAA2FE1A',
                        'Arn',
                      ],
                    },
                    '/tmp/*',
                  ],
                ],
              },
            ],
          },
          {
            Action: [
              's3:GetObject*',
              's3:GetBucket*',
              's3:List*',
            ],
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'ETLCompGlueJobBucketEAA2FE1A',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'ETLCompGlueJobBucketEAA2FE1A',
                        'Arn',
                      ],
                    },
                    `/artifacts/${scriptHash}/*`,
                  ],
                ],
              },
            ],
          },
          {
            Action: [
              's3:GetObject*',
              's3:GetBucket*',
              's3:List*',
            ],
            Effect: 'Allow',
            Resource: [
              {
                'Fn::GetAtt': [
                  'ETLCompGlueJobBucketEAA2FE1A',
                  'Arn',
                ],
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::GetAtt': [
                        'ETLCompGlueJobBucketEAA2FE1A',
                        'Arn',
                      ],
                    },
                    `/artifacts/${neptuneLibHash}/*`,
                  ],
                ],
              },
            ],
          },
          {
            Action: [
              's3:DeleteObject*',
              's3:PutObject*',
              's3:Abort*',
            ],
            Effect: 'Allow',
            Resource: [
              {
                Ref: 'referencetoTestStackBucket80A092C2Arn',
              },
              {
                'Fn::Join': [
                  '',
                  [
                    {
                      Ref: 'referencetoTestStackBucket80A092C2Arn',
                    },
                    '/fraud-detection/processed-data/*',
                  ],
                ],
              },
            ],
          },
        ],
      },
      Roles: [
        {
          Ref: 'ETLCompGlueJobRole97AC64F3',
        },
      ],
    });

    expect(stack).toHaveResourceLike('AWS::Glue::Job', {
      Command: {
        Name: 'glueetl',
        PythonVersion: '3',
        ScriptLocation: {
          'Fn::Join': [
            '',
            [
              's3://',
              {
                Ref: 'ETLCompGlueJobBucketEAA2FE1A',
              },
              `/artifacts/${scriptHash}/glue-etl.py`,
            ],
          ],
        },
      },
      Role: {
        'Fn::GetAtt': [
          'ETLCompGlueJobRole97AC64F3',
          'Arn',
        ],
      },
      Connections: {
        Connections: [
          {
            Ref: 'ETLCompNetworkConnection1C8EC8091',
          },
          {
            Ref: 'ETLCompNetworkConnection25132F300',
          },
        ],
      },
      DefaultArguments: {
        '--region': {
          Ref: 'AWS::Region',
        },
        '--database': {
          Ref: 'ETLCompFraudDetectionDatabaseFC554BB3',
        },
        '--transaction_table': {
          Ref: 'ETLCompTransactionTableCFEEAFA7',
        },
        '--identity_table': {
          Ref: 'ETLCompIdentityTableA8CCD6A3',
        },
        '--id_cols': 'card1,card2,card3,card4,card5,card6,ProductCD,addr1,addr2,P_emaildomain,R_emaildomain',
        '--cat_cols': 'M1,M2,M3,M4,M5,M6,M7,M8,M9',
        '--output_prefix': {
          'Fn::Join': [
            '',
            [
              's3://',
              {
                Ref: 'referencetoTestStackBucket80A092C2Ref',
              },
              '/fraud-detection/processed-data/',
            ],
          ],
        },
        '--job-language': 'python',
        '--job-bookmark-option': 'job-bookmark-disable',
        '--TempDir': {
          'Fn::Join': [
            '',
            [
              's3://',
              {
                Ref: 'ETLCompGlueJobBucketEAA2FE1A',
              },
              '/tmp/',
            ],
          ],
        },
        '--enable-continuous-cloudwatch-log': 'true',
        '--enable-continuous-log-filter': 'false',
        '--enable-metrics': '',
        '--extra-py-files': {
          'Fn::Join': [
            '',
            [
              's3://',
              {
                Ref: 'ETLCompGlueJobBucketEAA2FE1A',
              },
              `/artifacts/${neptuneLibHash}/neptune_python_utils.zip`,
            ],
          ],
        },
        '--neptune_endpoint': {
          Ref: 'referencetoTestStackDatabase1EBED910Endpoint',
        },
        '--neptune_port': {
          Ref: 'referencetoTestStackDatabase1EBED910Port',
        },
      },
      GlueVersion: '2.0',
      NumberOfWorkers: 2,
      WorkerType: 'G.2X',
      SecurityConfiguration: {
        Ref: 'ETLCompFraudDetectionSecConf653F0C00',
      },
    });
  });

  test('crawl lambda task is created.', () => {
    expect(stack).toHaveResourceLike('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: [
              'xray:PutTraceSegments',
              'xray:PutTelemetryRecords',
            ],
            Effect: 'Allow',
            Resource: '*',
          },
          {
            Action: 'glue:StartCrawler',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  {
                    Ref: 'AWS::Partition',
                  },
                  ':glue:',
                  {
                    Ref: 'AWS::Region',
                  },
                  ':',
                  {
                    Ref: 'AWS::AccountId',
                  },
                  ':crawler/',
                  {
                    Ref: 'ETLCompDataCrawlerE8BE0214',
                  },
                ],
              ],
            },
          },
          {
            Action: 'glue:GetCrawlerMetrics',
            Effect: 'Allow',
            Resource: '*',
          },
        ],
        Version: '2012-10-17',
      },
    });
  });

  test('model training pipeline is created.', () => {
    expect(stack).toHaveResourceLike('AWS::StepFunctions::StateMachine', {
      DefinitionString: {
        'Fn::Join': [
          '',
          [
            '{"StartAt":"Parameters normalize","States":{"Parameters normalize":{"Next":"Data Ingest","Retry":[{"ErrorEquals":["Lambda.ServiceException","Lambda.AWSLambdaException","Lambda.SdkClientException"],"IntervalSeconds":2,"MaxAttempts":6,"BackoffRate":2}],"Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::lambda:invoke","Parameters":{"FunctionName":"',
            {
              'Fn::GetAtt': [
                'ParametersNormalizeFunc879EBE6E',
                'Arn',
              ],
            },
            '","Payload.$":"$"},"ResultSelector":{"parameters.$":"$.Payload.parameters"}},"Data Ingest":{"Next":"Data Catalog Crawl","Retry":[{"ErrorEquals":["Lambda.ServiceException","Lambda.AWSLambdaException","Lambda.SdkClientException"],"IntervalSeconds":2,"MaxAttempts":6,"BackoffRate":2}],"Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","TimeoutSeconds":900,"ResultPath":null,"Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::lambda:invoke","Parameters":{"FunctionName":"',
            {
              'Fn::GetAtt': [
                'DataIngestFuncD21D4E7D',
                'Arn',
              ],
            },
            '","Payload.$":"$"}},"Data Catalog Crawl":{"Next":"Data Process","Retry":[{"ErrorEquals":["Lambda.ServiceException","Lambda.AWSLambdaException","Lambda.SdkClientException"],"IntervalSeconds":2,"MaxAttempts":6,"BackoffRate":2}],"Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","TimeoutSeconds":900,"ResultPath":null,"Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::lambda:invoke","Parameters":{"FunctionName":"',
            {
              'Fn::GetAtt': [
                'DataCatalogCrawlerE389E8CA',
                'Arn',
              ],
            },
            '","Payload":{"crawlerName":"',
            {
              Ref: 'ETLCompDataCrawlerE8BE0214',
            },
            '"}}},"Data Process":{"Next":"Train model","Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","ResultPath":"$.dataProcessOutput","Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::glue:startJobRun.sync","Parameters":{"JobName":"',
            {
              Ref: 'ETLCompPreprocessingJobB535A575',
            },
            '","Timeout":300}},"Train model":{"Next":"Load the props to graph","Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","ResultPath":"$.trainingJobOutput","Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ":states:::sagemaker:createTrainingJob.sync\",\"Parameters\":{\"TrainingJobName.$\":\"States.Format('fraud-detection-model-{}', $.dataProcessOutput.CompletedOn)\",\"RoleArn\":\"",
            {
              'Fn::GetAtt': [
                'TrainmodelSagemakerRoleDFEA40B5',
                'Arn',
              ],
            },
            '","AlgorithmSpecification":{"TrainingInputMode":"File","TrainingImage":"',
            {
              'Fn::FindInMap': [
                'CustomTrainingModelMapping',
                {
                  Ref: 'AWS::Partition',
                },
                'accountId',
              ],
            },
            '.dkr.ecr.',
            {
              Ref: 'AWS::Region',
            },
            '.',
            {
              Ref: 'AWS::URLSuffix',
            },
            '/fraud-detection-with-gnn-on-dgl/training:1.0.0.202104261630"},"InputDataConfig":[{"ChannelName":"train","DataSource":{"S3DataSource":{"S3Uri":"https://s3.',
            {
              Ref: 'AWS::Region',
            },
            '.',
            {
              Ref: 'AWS::URLSuffix',
            },
            '/',
            {
              Ref: 'referencetoTestStackBucket80A092C2Ref',
            },
            '/fraud-detection/processed-data/","S3DataType":"S3Prefix"}}}],"OutputDataConfig":{"S3OutputPath":"https://s3.',
            {
              Ref: 'AWS::Region',
            },
            '.',
            {
              Ref: 'AWS::URLSuffix',
            },
            '/',
            {
              Ref: 'referencetoTestStackBucket80A092C2Ref',
            },
            '/fraud-detection/model_output"},"ResourceConfig":{"VolumeSizeInGB":50,"InstanceCount.$":"$.parameters.trainingJob.instanceCount","InstanceType.$":"$.parameters.trainingJob.instanceType"},"StoppingCondition":{"MaxRuntimeInSeconds.$":"$.parameters.trainingJob.timeoutInSeconds"},"HyperParameters.$":"$.parameters.trainingJob.hyperparameters"},"ResultSelector":{"TrainingJobName.$":"$.TrainingJobName","ModelArtifacts.$":"$.ModelArtifacts"}},"Load the props to graph":{"Next":"Package model with code","Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","TimeoutSeconds":7200,"ResultPath":null,"Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::ecs:runTask.sync","Parameters":{"Cluster":"',
            {
              'Fn::GetAtt': [
                'FraudDetectionClusterA78016CF',
                'Arn',
              ],
            },
            '","TaskDefinition":"training-pipeline-load-props","NetworkConfiguration":{"AwsvpcConfiguration":{"Subnets":["',
            {
              Ref: 'referencetoTestStackVpcPrivateSubnet1Subnet707BB947Ref',
            },
            '","',
            {
              Ref: 'referencetoTestStackVpcPrivateSubnet2Subnet5DE74951Ref',
            },
            '"],"SecurityGroups":["',
            {
              'Fn::GetAtt': [
                'LoadPropsSGED21E180',
                'GroupId',
              ],
            },
            '"]}},"Overrides":{"ContainerOverrides":[{"Name":"container","Command":["--data_prefix","s3://',
            {
              Ref: 'referencetoTestStackBucket80A092C2Ref',
            },
            '/s3://bucket/object/folder","--temp_folder","/mnt/efs","--neptune_endpoint","',
            {
              Ref: 'referencetoTestStackDatabase1EBED910Endpoint',
            },
            '","--neptune_port","',
            {
              Ref: 'referencetoTestStackDatabase1EBED910Port',
            },
            '","--region","',
            {
              Ref: 'AWS::Region',
            },
            '","--neptune_iam_role_arn","arn:aws::123456789012:role/neptune-role"],"Environment":[{"Name":"MODEL_PACKAGE","Value.$":"$.trainingJobOutput.ModelArtifacts.S3ModelArtifacts"},{"Name":"JOB_NAME","Value.$":"$.trainingJobOutput.TrainingJobName"}]}]},"LaunchType":"FARGATE","PlatformVersion":"1.4.0"}},"Package model with code":{"Next":"Create model","Retry":[{"ErrorEquals":["Lambda.ServiceException","Lambda.AWSLambdaException","Lambda.SdkClientException"],"IntervalSeconds":2,"MaxAttempts":6,"BackoffRate":2}],"Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","TimeoutSeconds":900,"ResultPath":"$.modelPackagingOutput","Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::lambda:invoke","Parameters":{"FunctionName":"',
            {
              'Fn::GetAtt': [
                'ModelRepackageFunc67DC83F1',
                'Arn',
              ],
            },
            '","Payload":{"ModelArtifact.$":"$.trainingJobOutput.ModelArtifacts.S3ModelArtifacts"}},"ResultSelector":{"RepackagedArtifact.$":"$.Payload.RepackagedArtifact"}},"Create model":{"Next":"Create endpoint config","Type":"Task","ResultPath":"$.modelOutput","Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::sagemaker:createModel","Parameters":{"ExecutionRoleArn":"',
            {
              'Fn::GetAtt': [
                'CreatemodelSagemakerRole842D47F8',
                'Arn',
              ],
            },
            '","ModelName.$":"$.trainingJobOutput.TrainingJobName","PrimaryContainer":{"Image":"',
            {
              'Fn::FindInMap': [
                'DeepLearningImagesMapping',
                {
                  Ref: 'AWS::Region',
                },
                'accountId',
              ],
            },
            '.dkr.ecr.',
            {
              Ref: 'AWS::Region',
            },
            '.',
            {
              Ref: 'AWS::URLSuffix',
            },
            '/pytorch-inference:1.6.0-cpu-py36-ubuntu16.04","Mode":"SingleModel","ModelDataUrl.$":"$.modelPackagingOutput.RepackagedArtifact","Environment":{"SAGEMAKER_PROGRAM":"fd_sl_deployment_entry_point.py","HIDDEN_SIZE.$":"$.parameters.trainingJob.hyperparameters[\'n-hidden\']"}}},"ResultSelector":{"ModelArn.$":"$.ModelArn"}},"Create endpoint config":{"Next":"Check the existence of endpoint","Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","ResultPath":"$.endpointConfigOutput","Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::sagemaker:createEndpointConfig","Parameters":{"EndpointConfigName.$":"$.trainingJobOutput.TrainingJobName","ProductionVariants":[{"InitialInstanceCount":1,"InstanceType":"ml.c5.4xlarge","ModelName.$":"$.trainingJobOutput.TrainingJobName","VariantName":"c5-4x"}]},"ResultSelector":{"EndpointConfigArn.$":"$.EndpointConfigArn"}},"Check the existence of endpoint":{"Next":"Create or update endpoint","Retry":[{"ErrorEquals":["Lambda.ServiceException","Lambda.AWSLambdaException","Lambda.SdkClientException"],"IntervalSeconds":2,"MaxAttempts":6,"BackoffRate":2}],"Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","TimeoutSeconds":30,"ResultPath":"$.checkEndpointOutput","Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::lambda:invoke","Parameters":{"FunctionName":"',
            {
              'Fn::GetAtt': [
                'CheckEndpointFunc8466DC7A',
                'Arn',
              ],
            },
            '","Payload":{"EndpointName":"frauddetection"}},"ResultSelector":{"Endpoint.$":"$.Payload.Endpoint"}},"Create or update endpoint":{"Type":"Choice","Choices":[{"Variable":"$.checkEndpointOutput.Endpoint.frauddetection","BooleanEquals":false,"Next":"Create endpoint"}],"Default":"Update endpoint"},"Update endpoint":{"End":true,"Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::sagemaker:updateEndpoint","Parameters":{"EndpointConfigName.$":"$.trainingJobOutput.TrainingJobName","EndpointName":"frauddetection"}},"Fail":{"Type":"Fail","Comment":"The model training & deployment pipeline failed."},"Create endpoint":{"End":true,"Catch":[{"ErrorEquals":["States.ALL"],"ResultPath":"$.error","Next":"Fail"}],"Type":"Task","Resource":"arn:',
            {
              Ref: 'AWS::Partition',
            },
            ':states:::sagemaker:createEndpoint","Parameters":{"EndpointConfigName.$":"$.trainingJobOutput.TrainingJobName","EndpointName":"frauddetection"}}}}',
          ],
        ],
      },
      TracingConfiguration: {
        Enabled: true,
      },
    });
  });

  // see https://docs.aws.amazon.com/step-functions/latest/dg/bp-cwl.html for detail
  test('log group of states is applied the best practise.', () => {
    expect(stack).toHaveResourceLike('AWS::Logs::LogGroup', {
      Properties: {
        LogGroupName: {
          'Fn::Join': [
            '',
            [
              '/aws/vendedlogs/states/fraud-detetion/training-pipeline/',
              {
                Ref: 'AWS::StackName',
              },
            ],
          ],
        },
        RetentionInDays: 180,
      },
      UpdateReplacePolicy: 'Retain',
      DeletionPolicy: 'Retain',
    }, ResourcePart.CompleteDefinition);
    expect(stack).toHaveResourceLike('AWS::StepFunctions::StateMachine', {
      LoggingConfiguration: {
        Destinations: [
          {
            CloudWatchLogsLogGroup: {
              LogGroupArn: {
                'Fn::GetAtt': [
                  'FraudDetectionLogGroupE14295CC',
                  'Arn',
                ],
              },
            },
          },
        ],
        IncludeExecutionData: true,
        Level: 'ALL',
      },
    });
  });

  test('model repackaging is created.', () => {
    // EFS is created
    expect(stack).toHaveResourceLike('AWS::EFS::FileSystem', {
      Properties: {
        Encrypted: true,
        LifecyclePolicies: [
          {
            TransitionToIA: 'AFTER_14_DAYS',
          },
        ],
      },
      UpdateReplacePolicy: 'Delete',
      DeletionPolicy: 'Delete',
    },
    ResourcePart.CompleteDefinition);
    expect(stack).toHaveResourceLike('AWS::EFS::AccessPoint', {
      FileSystemId: {
        Ref: 'TempFilesystem02DFD7EB',
      },
      PosixUser: {
        Gid: '0',
        Uid: '0',
      },
      RootDirectory: {
        CreationInfo: {
          OwnerGid: '0',
          OwnerUid: '0',
          Permissions: '750',
        },
        Path: '/',
      },
    },
    );

    expect(stack).toHaveResourceLike('AWS::Lambda::Function', {
      Code: {
        S3Bucket: {
        },
      },
      Handler: 'app.handler',
      Layers: [
        {
          Ref: 'AwsCliLayerF44AAF94',
        },
        {
          Ref: 'TarLayer1AD5AF62',
        },
      ],
      Runtime: 'python3.7',
      Environment: {
        Variables: {
          CodePackage: {
            'Fn::Join': [
              '',
              [
                's3://',
                {
                  Ref: 'referencetoTestStackBucket80A092C2Ref',
                },
                `/fraud-detection/model/code/${codeDirHash}`,
              ],
            ],
          },
          TempFolder: '/mnt/efs',
        },
      },
      FileSystemConfigs: [
        {
          Arn: {
            'Fn::Join': [
              '',
              [
                'arn:',
                {
                  Ref: 'AWS::Partition',
                },
                ':elasticfilesystem:',
                {
                  Ref: 'AWS::Region',
                },
                ':',
                {
                  Ref: 'AWS::AccountId',
                },
                ':access-point/',
                {
                  Ref: 'TempFilesystemTempFSAccessPointEBC97992',
                },
              ],
            ],
          },
          LocalMountPath: '/mnt/efs',
        },
      ],
      TracingConfig: {
        Mode: 'Active',
      },
    });
  });
});

function initializeStackWithContextsAndEnvs(context: {} | undefined, env?: {} | undefined) {
  const app = new App({
    context,
  });
  const parentStack = new Stack(app, 'TestStack', { env: env });
  const vpc = new Vpc(parentStack, 'Vpc');
  const bucket = new Bucket(parentStack, 'Bucket');
  const cluster = new DatabaseCluster(parentStack, 'Database', {
    vpc,
    instanceType: InstanceType.R5_LARGE,
    port: 8182,
  });
  const accessLogBucket = new Bucket(parentStack, 'AccessLog');

  const stack = new TrainingStack(parentStack, 'TestStack', {
    vpc,
    bucket,
    accessLogBucket,
    neptune: {
      cluster,
      loadRole: 'arn:aws::123456789012:role/neptune-role',
      loadObjectPrefix: 's3://bucket/object/folder',
    },
    dataPrefix: 'fraud-detection/',
    dataColumnsArg: {
      id_cols: 'card1,card2,card3,card4,card5,card6,ProductCD,addr1,addr2,P_emaildomain,R_emaildomain',
      cat_cols: 'M1,M2,M3,M4,M5,M6,M7,M8,M9',
    },
  });
  return { stack };
}
