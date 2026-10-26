import { APIGatewayClient, GetApiKeyCommand } from '@aws-sdk/client-api-gateway';
import { PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export interface MirrorEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ResourceProperties: { ApiKeyId: string; SecretId: string };
}

export interface MirrorDeps {
  getApiKeyValue: (apiKeyId: string) => Promise<string | undefined>;
  putSecretValue: (secretId: string, value: string) => Promise<void>;
}

// Only the physical id goes back to CloudFormation: anything returned here lands in the provider's logs and could be
// read back through GetAtt, and the key value must stay out of both.
export async function mirrorApiKey(event: MirrorEvent, deps: MirrorDeps): Promise<{ PhysicalResourceId: string }> {
  const { ApiKeyId, SecretId } = event.ResourceProperties;
  if (event.RequestType !== 'Delete') {
    const value = await deps.getApiKeyValue(ApiKeyId);
    if (!value) throw new Error(`API key ${ApiKeyId} has no value`);
    await deps.putSecretValue(SecretId, value);
  }
  return { PhysicalResourceId: SecretId };
}

const apigateway = new APIGatewayClient({});
const secretsManager = new SecretsManagerClient({});

export async function handler(event: MirrorEvent): Promise<{ PhysicalResourceId: string }> {
  return mirrorApiKey(event, {
    getApiKeyValue: async (apiKeyId) =>
      (await apigateway.send(new GetApiKeyCommand({ apiKey: apiKeyId, includeValue: true }))).value,
    putSecretValue: async (secretId, value) => {
      await secretsManager.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: value }));
    },
  });
}
