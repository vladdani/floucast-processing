# GitHub Actions ECS Deployment Setup

## Overview

This document explains how to set up the GitHub Actions workflow for automatically deploying the Document Processor to AWS ECS on every push to the main branch.

## Prerequisites

### AWS Infrastructure Requirements

1. **ECS Cluster**: `floucast-production`
2. **ECS Service**: `document-processor-service`
3. **ECR Repository**: `floucast-processor`
4. **IAM Roles**:
   - `ecsTaskExecutionRole` (for pulling images and logging)
   - `ecsTaskRole` (for application AWS permissions)

### GitHub Repository Secrets

Configure the following secrets in your GitHub repository settings:

#### Required Secrets
```
AWS_ACCESS_KEY_ID          # AWS access key for deployment
AWS_SECRET_ACCESS_KEY      # AWS secret key for deployment
AWS_ACCOUNT_ID             # Your AWS account ID (12-digit number)
```

#### Optional Secrets
```
DOCUMENT_PROCESSOR_ENDPOINT # Load balancer endpoint for health checks
                           # Example: https://processor.yourdomain.com
```

## AWS Systems Manager Parameters

Store sensitive configuration in AWS Systems Manager Parameter Store:

### Required Parameters
```bash
# Store these parameters in AWS Systems Manager
aws ssm put-parameter \
  --name "/document-processor/supabase-url" \
  --value "https://your-project.supabase.co" \
  --type "SecureString"

aws ssm put-parameter \
  --name "/document-processor/supabase-service-role-key" \
  --value "your-service-role-key" \
  --type "SecureString"

aws ssm put-parameter \
  --name "/document-processor/gemini-api-key" \
  --value "your-gemini-api-key" \
  --type "SecureString"

aws ssm put-parameter \
  --name "/document-processor/sqs-queue-url" \
  --value "https://sqs.us-east-1.amazonaws.com/123456789012/document-processing-queue" \
  --type "SecureString"

aws ssm put-parameter \
  --name "/document-processor/redis-endpoint" \
  --value "your-redis-endpoint:6379" \
  --type "SecureString"
```

## IAM Permissions

### GitHub Actions User Permissions

The AWS user credentials used by GitHub Actions need these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecs:RegisterTaskDefinition",
        "ecs:UpdateService",
        "ecs:DescribeServices",
        "ecs:DescribeTaskDefinition",
        "ecs:DescribeTasks",
        "ecs:ListTasks"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "iam:PassRole"
      ],
      "Resource": [
        "arn:aws:iam::*:role/ecsTaskExecutionRole",
        "arn:aws:iam::*:role/ecsTaskRole"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters"
      ],
      "Resource": "arn:aws:ssm:*:*:parameter/document-processor/*"
    }
  ]
}
```

### ECS Task Execution Role

Ensure your `ecsTaskExecutionRole` has these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters"
      ],
      "Resource": "arn:aws:ssm:*:*:parameter/document-processor/*"
    }
  ]
}
```

### ECS Task Role

Your `ecsTaskRole` needs permissions for the application to work:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:*:*:document-processing-queue"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": "arn:aws:s3:::your-supabase-bucket/*"
    }
  ]
}
```

## CloudWatch Logs Setup

Create the log group for ECS tasks:

```bash
aws logs create-log-group \
  --log-group-name "/aws/ecs/document-processor" \
  --retention-in-days 30
```

## Infrastructure Setup Scripts

### 1. Create ECS Cluster

```bash
#!/bin/bash
# Create ECS cluster
aws ecs create-cluster \
  --cluster-name floucast-production \
  --capacity-providers FARGATE \
  --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1
```

### 2. Create ECR Repository

```bash
#!/bin/bash
# Create ECR repository
aws ecr create-repository \
  --repository-name floucast-processor \
  --encryption-configuration encryptionType=AES256
```

### 3. Create Initial ECS Service

```bash
#!/bin/bash
# This creates the initial service - the GitHub Action will update it
aws ecs create-service \
  --cluster floucast-production \
  --service-name document-processor-service \
  --task-definition document-processor-task:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx,subnet-yyy],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --enable-execute-command
```

## Workflow Configuration

### Environment Variables

You can customize these environment variables in the workflow:

```yaml
env:
  AWS_REGION: us-east-1                    # Change to your preferred region
  ECR_REPOSITORY: floucast-processor       # Your ECR repository name
  ECS_SERVICE: document-processor-service  # Your ECS service name
  ECS_CLUSTER: floucast-production         # Your ECS cluster name
  ECS_TASK_DEFINITION: document-processor-task # Your task definition family
```

### Task Definition Configuration

The workflow automatically creates a task definition with:

- **CPU**: 4096 (4 vCPU)
- **Memory**: 16384 MB (16 GB)
- **Network Mode**: awsvpc (required for Fargate)
- **Health Check**: HTTP check on `/health` endpoint
- **Logging**: CloudWatch logs with 30-day retention
- **Secrets**: Loaded from AWS Systems Manager Parameter Store

## Deployment Process

### Automatic Deployment Triggers

The workflow runs automatically on:

1. **Push to main branch** with changes in `aws-document-processor/` directory
2. **Manual workflow dispatch** from GitHub Actions UI

### Deployment Steps

1. **Build Phase**:
   - Checkout code
   - Configure AWS credentials
   - Login to ECR
   - Build Docker image
   - Push to ECR with commit SHA and 'latest' tags

2. **Deploy Phase**:
   - Create new task definition with updated image
   - Deploy to ECS service
   - Wait for service stability
   - Verify deployment health

3. **Verification Phase**:
   - Check service status
   - Run health check against load balancer (if configured)
   - Display deployment summary

4. **Rollback Phase** (on failure):
   - Automatically rollback to previous task definition
   - Notify about rollback status

## Monitoring and Troubleshooting

### Deployment Status

Monitor deployments through:

1. **GitHub Actions tab** in your repository
2. **AWS ECS Console** - Service events and task status
3. **CloudWatch Logs** - Application and deployment logs

### Common Issues

#### 1. Build Failures
```bash
# Check Docker build context
cd aws-document-processor
docker build -t test-build .
```

#### 2. Task Startup Failures
```bash
# Check ECS service events
aws ecs describe-services \
  --cluster floucast-production \
  --services document-processor-service \
  --query 'services[0].events[:10]'
```

#### 3. Health Check Failures
```bash
# Check task logs
aws logs get-log-events \
  --log-group-name "/aws/ecs/document-processor" \
  --log-stream-name "ecs/document-processor/TASK-ID" \
  --start-time $(date -d '10 minutes ago' +%s)000
```

### Manual Rollback

If automatic rollback fails:

```bash
# List previous task definitions
aws ecs list-task-definitions \
  --family-prefix document-processor-task \
  --sort DESC

# Manually update service to previous version
aws ecs update-service \
  --cluster floucast-production \
  --service document-processor-service \
  --task-definition document-processor-task:PREVIOUS_REVISION
```

## Security Best Practices

### 1. Least Privilege Access
- GitHub Actions user has minimal required permissions
- Task roles follow principle of least privilege
- Secrets stored in AWS Systems Manager Parameter Store

### 2. Image Security
- Base image is Alpine Linux (minimal attack surface)
- Non-root user execution
- Read-only root filesystem
- Security scanning with Docker Scout (optional)

### 3. Network Security
- VPC with private subnets recommended
- Security groups with minimal required ports
- Application Load Balancer for HTTPS termination

### 4. Secrets Management
- No secrets in code or GitHub repository
- AWS Systems Manager Parameter Store encryption
- Regular secret rotation recommended

## Cost Optimization

### Resource Sizing
- **Development**: 2 vCPU, 8GB memory
- **Production**: 4 vCPU, 16GB memory
- **High Load**: Auto-scaling based on queue depth

### Auto Scaling Configuration

```bash
# Create auto scaling target
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/floucast-production/document-processor-service \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 1 \
  --max-capacity 10

# Create scaling policy
aws application-autoscaling put-scaling-policy \
  --policy-name document-processor-cpu-scaling \
  --service-namespace ecs \
  --resource-id service/floucast-production/document-processor-service \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration file://scaling-policy.json
```

## Testing the Workflow

### 1. Test Build Locally
```bash
cd aws-document-processor
docker build -t floucast-processor:test .
docker run -p 8080:8080 --env-file .env floucast-processor:test
curl http://localhost:8080/health
```

### 2. Test Deployment
1. Make a change to `aws-document-processor/README.md`
2. Commit and push to main branch
3. Monitor GitHub Actions workflow
4. Verify deployment in AWS ECS Console

### 3. Test Rollback
1. Introduce an error (e.g., invalid Dockerfile syntax)
2. Push to main branch
3. Verify automatic rollback occurs
4. Check service returns to previous stable state

This setup provides a robust, automated deployment pipeline for your document processing service with built-in rollback capabilities and comprehensive monitoring.