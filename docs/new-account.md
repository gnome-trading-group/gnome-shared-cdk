## Creating a new account

This document is a brief overview of the manual steps needing when creating a new AWS account.

### Step 1: Secrets

1. `GITHUB_MAVEN`

### Step 2: Bootstrapping CDK

```
regions=(
  us-east-1
  us-east-2
  us-west-1
  us-west-2
  eu-west-1
  eu-west-2
  eu-central-1
  ap-northeast-1
  ap-northeast-2
  ap-southeast-1
  ap-southeast-2
  ap-south-1
  sa-east-1
)
account_id=<ACCOUNT_ID>
for region in "${regions[@]}"; do
    cdk bootstrap \
      $account_id/$region \
      --trust 443370708724 \
      --trust-for-lookup 443370708724 \
      --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess \
      --profile AWSAdministratorAccess-$account_id
done

wait
```
