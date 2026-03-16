# Azure Deployment with Terraform

This directory contains Terraform configuration to deploy the Discord ScoutID Linked Role application to Azure in a cost-effective manner.

## Architecture

The deployment uses the following Azure services:

- **Azure Container Apps**: Serverless container hosting with consumption-based pricing and scale-to-zero capability
- **Azure Cache for Redis**: Basic C0 tier (250 MB) for session storage
- **Azure Container Registry**: Basic tier for storing Docker images
- **Log Analytics Workspace**: For monitoring and logging

## Cost Estimate

Approximate monthly costs (as of 2025):
- Container Apps: ~$0-5/month (with scale to zero)
- Redis Cache Basic C0: ~$16/month
- Container Registry Basic: ~$5/month
- Log Analytics: ~$2-5/month (depending on logs)

**Total: ~$28-31/month**

> Note: Costs may vary by region. The default configuration uses `swedencentral` (Sweden Central) region.

## Prerequisites

1. **Azure CLI**: [Install Azure CLI](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli)
2. **Terraform**: [Install Terraform](https://www.terraform.io/downloads.html) (>= 1.0)
3. **Docker**: For building and pushing images
4. **Azure Subscription**: Active Azure subscription

## Setup Instructions

### 1. Login to Azure

```bash
az login
az account set --subscription "YOUR_SUBSCRIPTION_ID"
```

### 2. Register Azure Resource Providers

Before deploying, register the required Azure resource providers (this only needs to be done once per subscription):

```bash
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights
az provider register --namespace Microsoft.ContainerRegistry
az provider register --namespace Microsoft.Cache
```

This takes 2-5 minutes. You can check the registration status with:

```bash
az provider show -n Microsoft.App --query "registrationState" -o tsv
```

Wait until all providers show "Registered" before proceeding.

### 3. Configure Variables

The configuration is split into two files for better security:

**Non-sensitive configuration** (`terraform.tfvars`):
```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` for project name, region, and scaling settings.

**Sensitive secrets** (`secrets.tfvars`):
```bash
cp secrets.tfvars.example secrets.tfvars
```

Edit `secrets.tfvars` with your actual API keys, tokens, and secrets. This file is automatically ignored by git.

### 4. Initialize Terraform

```bash
terraform init
```

### 5. Review the Plan

```bash
terraform plan -var-file="terraform.tfvars" -var-file="secrets.tfvars"
```

### 6. Deploy Infrastructure

```bash
terraform apply -var-file="terraform.tfvars" -var-file="secrets.tfvars"
```

Type `yes` when prompted to confirm the deployment.

### 7. Build and Push Docker Image

After the infrastructure is created, Terraform will output commands to push your Docker image. Run them from the project root directory:

```bash
# Get the commands from Terraform output
terraform output -raw deployment_commands

# Or manually:
az acr login --name <registry-name>
docker build -t <registry-url>/discord-scoutid-linked-role:latest .
docker push <registry-url>/discord-scoutid-linked-role:latest
```

### 8. Update Discord and ScoutID Settings

After deployment, update your OAuth redirect URIs:

```bash
# Get the URLs from Terraform output
terraform output discord_redirect_uri
terraform output discord_validation_url
terraform output scoutid_redirect_uri
```

Update these URLs in:
- Discord Developer Portal (OAuth2 settings)
- ScoutID application settings

### 9. Verify Deployment

```bash
# Get the application URL
terraform output container_app_url

# Test the application
curl https://<your-app-url>
```

## Updating the Application

To deploy a new version:

```bash
# Build new image with version tag
docker build -t <registry-url>/discord-scoutid-linked-role:v1.1 .
docker push <registry-url>/discord-scoutid-linked-role:v1.1

# Update the image tag in terraform.tfvars
docker_image_tag = "v1.1"

# Apply the changes
terraform apply
```

Or use the Container App revision feature:

```bash
az containerapp update \
  --name discord-scoutid-app \
  --resource-group discord-scoutid-rg \
  --image <registry-url>/discord-scoutid-linked-role:latest
```

## Managing Secrets

Secrets are stored as Container App secrets. To update a secret:

```bash
az containerapp secret set \
  --name discord-scoutid-app \
  --resource-group discord-scoutid-rg \
  --secrets "discord-token=NEW_TOKEN_VALUE"
```

Then restart the app:

```bash
az containerapp revision restart \
  --name discord-scoutid-app \
  --resource-group discord-scoutid-rg
```

## Monitoring

View logs using Azure Portal or CLI:

```bash
# Stream logs
az containerapp logs show \
  --name discord-scoutid-app \
  --resource-group discord-scoutid-rg \
  --follow

# View recent logs
az containerapp logs show \
  --name discord-scoutid-app \
  --resource-group discord-scoutid-rg \
  --tail 100
```

## Cost Optimization Tips

1. **Scale to Zero**: The default configuration allows scaling to 0 replicas when not in use
2. **Redis Tier**: Using Basic C0 (smallest tier). Upgrade only if you need more memory
3. **Log Retention**: Set to 30 days. Reduce if not needed
4. **Region Selection**: Using `swedencentral` for data residency in Sweden

## Cleanup

To destroy all resources and stop incurring costs:

```bash
terraform destroy
```

Type `yes` to confirm deletion of all resources.

## Troubleshooting

### Container fails to start
- Check logs: `az containerapp logs show --name discord-scoutid-app --resource-group discord-scoutid-rg`
- Verify environment variables are set correctly
- Ensure Docker image was pushed successfully

### Redis connection issues
- Verify Redis is running: `az redis show --name discord-scoutid-redis --resource-group discord-scoutid-rg`
- Check REDIS_URL format in environment variables

### OAuth redirect errors
- Verify redirect URIs match exactly in Discord/ScoutID settings
- Check Container App URL in outputs

## Additional Resources

- [Azure Container Apps Documentation](https://docs.microsoft.com/en-us/azure/container-apps/)
- [Azure Cache for Redis Documentation](https://docs.microsoft.com/en-us/azure/azure-cache-for-redis/)
- [Terraform Azure Provider Documentation](https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs)
