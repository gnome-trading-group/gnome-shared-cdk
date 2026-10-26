import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as path from 'path';
import { Construct } from 'constructs';

/**
 * Fixed names, so consumers find a key's secret without a cross-stack import. All live in us-east-1; callers in
 * other regions read them from there.
 */
export const API_KEY_SECRET_NAMES = {
  REGISTRY: 'gnome/api-keys/registry',
  CONTROLLER_SERVICE_CONFIG: 'gnome/api-keys/controller-service-config',
} as const;

export interface ApiKeySecretProps {
  apiKey: apigw.IApiKey;
  secretName: string;
}

/**
 * Mirrors an existing API key's value into a Secrets Manager secret, so services read the secret at startup instead
 * of calling GetApiKey: that call is account-wide and tightly throttled, and clustered cold starts get 429s.
 *
 * The value is copied, never generated, so clients already holding the key keep working. It is written by a Lambda
 * and never passes through the template, an output or a GetAtt.
 */
export class ApiKeySecret extends Construct {
  public readonly secret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: ApiKeySecretProps) {
    super(scope, id);

    // CloudFormation only ever sees this placeholder; the mirror overwrites it on every create and update. Changing
    // this resource's properties rewrites the placeholder without re-running the mirror, so leave them alone.
    this.secret = new secretsmanager.Secret(this, 'Secret', {
      secretName: props.secretName,
      description: 'Mirror of an API Gateway key value, written by the stack that owns the key',
      secretStringValue: cdk.SecretValue.unsafePlainText('pending'),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'MirrorFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'api-key-secret')),
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
    });
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [props.apiKey.keyArn],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:PutSecretValue'],
      resources: [this.secret.secretArn],
    }));

    const provider = new cr.Provider(this, 'Provider', { onEventHandler: fn });
    // The key id is a property so replacing the key re-runs the mirror.
    new cdk.CustomResource(this, 'Mirror', {
      serviceToken: provider.serviceToken,
      properties: { ApiKeyId: props.apiKey.keyId, SecretId: this.secret.secretArn },
    });
  }
}
