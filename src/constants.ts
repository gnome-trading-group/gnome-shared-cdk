export enum Stage {
  DEV = "dev",
  STAGING = "staging",
  PROD = "prod",
  PIPELINES = "pipelines",
}

export class GnomeAccount {

  public static readonly InfraDev = new GnomeAccount(
    "infra-dev", "443370708724", "us-east-1", Stage.DEV,
  );
  public static readonly InfraStaging = new GnomeAccount(
    "infra-staging", "774305600313", "us-east-1", Stage.DEV,
  );
  public static readonly InfraProd = new GnomeAccount(
    "infra-prod", "241533121172", "us-east-1", Stage.DEV,
  );
  public static readonly InfraPipelines = new GnomeAccount(
    "infra-pipelines", "043309336849", "us-east-1", Stage.PIPELINES,
  )
  
  private constructor(
    public readonly name: string,
    public readonly accountId: string,
    public readonly region: string,
    public readonly stage: Stage,
  ) {}
}

export const INFRA_ACCOUNTS = [GnomeAccount.InfraDev, GnomeAccount.InfraStaging, GnomeAccount.InfraProd];
