// Kept free of aws-cdk-lib imports: this file ships inside the authorizer Lambda's asset alongside handler.js.

export enum CallerKind {
  SERVICE = "service",
  PERSON = "person",
  BOT = "bot",
}

export const BOT_RESOURCE_SERVER = "gnome-api";
export const BOT_READ_SCOPE = "bot.read";
export const BOT_WRITE_SCOPE = "bot.write";
