# Floucast Architecture Separation Plan

## Overview

This document outlines the plan to separate the current monolithic Floucast application into two specialized applications:

1. **Original App (Frontend + Upload)** - Handles user interface and file uploads
2. **Processing App (AI + Queue Processing)** - Handles document processing and AI extraction

## Current State Analysis

Based on the original flow document, the current system processes thousands of documents monthly but has significant reliability issues costing $3,000-6,000/month in operational overhead.

### Current Issues
- **Webhook Reliability**: 30% failure rate for large files
- **No Real-time Updates**: Users don't know when processing completes
- **Hardcoded Bucket**: Download function only works for accounting docs
- **Build Issues**: `ignoreBuildErrors: true` allows type errors in production
- **Excessive Logging**: 3,615+ console statements in production

## Architecture Separation Strategy

### 1. Processing App (This Repository)

**Purpose**: Dedicated AWS ECS service for AI document processing

**Current State**: ✅ Already implemented with the following features:
- AWS ECS containerized service
- SQS queue processing capability
- Google Gemini 2.0 Flash AI integration
- Supabase database integration
- Multi-format document support (PDF, DOCX, XLSX, Images, HEIC/HEIF)
- Health checks and monitoring
- Real-time status updates via Supabase

**Key Responsibilities**:
- Receive processing jobs from SQS queue
- Download files from Supabase Storage
- Perform AI extraction using Google Gemini
- Generate vector embeddings for search
- Update database with processed results
- Send real-time notifications via Supabase Real-time

**API Endpoints**:
```
GET  /health         - Health check
GET  /metrics        - Processing metrics
POST /process        - Manual processing trigger
```

**Processing Flow**:
```
SQS Queue → ECS Service → Supabase DB
    ↓            ↓             ↑
Processing   Gemini AI    Results
```

### 2. Original App Updates (Frontend + Upload Only)

**Purpose**: Streamlined Next.js application focused on user interface and file uploads

**Required Changes**:

#### A. Remove Processing Logic
- Remove all AI processing endpoints:
  - `/api/process-document`
  - `/api/process-legal-document` 
  - `/verticals/accounting/api/process-document`
  - `/verticals/legal/api/process-legal-document`
- Remove Google Gemini AI dependencies
- Remove direct document processing logic
- Remove processing queue management code

#### B. Implement Queue-Based Processing
Replace direct processing calls with SQS queue submissions:

```javascript
// OLD: Direct processing call
await fetch('/api/process-document', {
  method: 'POST',
  body: JSON.stringify({ documentId, source: 'simple-upload' })
})

// NEW: Queue submission
await fetch('/api/queue-document', {
  method: 'POST', 
  body: JSON.stringify({ 
    documentId, 
    vertical, 
    organizationId,
    priority: fileSize > 10000000 ? 'high' : 'normal'
  })
})
```

#### C. Enhanced Real-time Updates
Implement Supabase Real-time subscriptions to replace polling:

```javascript
// Replace polling with real-time subscriptions
const subscription = supabase
  .channel(`document_${documentId}`)
  .on('postgres_changes', {
    event: 'UPDATE',
    schema: 'public',
    table: 'documents',
    filter: `id=eq.${documentId}`
  }, (payload) => {
    if (payload.new.processing_status === 'complete') {
      updateDocumentUI(payload.new)
      subscription.unsubscribe()
    }
  })
  .subscribe()
```

#### D. New API Endpoints
```
POST /api/queue-document          - Submit document to processing queue
POST /api/queue-legal-document    - Submit legal document to processing queue  
GET  /api/processing-status/:id   - Get current processing status
```

#### E. Updated Upload Flow
```
1. File Upload → Supabase Storage ✓ (unchanged)
2. Database Record Creation ✓ (unchanged) 
3. Queue Submission → SQS Queue (NEW)
4. Real-time Status Updates ← Supabase Real-time (NEW)
5. UI Updates → Show processed results (enhanced)
```

## Implementation Plan

### Phase 1: Processing App (✅ Complete)
The processing app is already implemented with all required functionality:
- Container deployment ready
- AI processing pipeline operational
- Queue management system functional
- Health monitoring and metrics available

### Phase 2: Original App Migration

#### Step 1: Add Queue Integration
- Install AWS SDK: `npm install @aws-sdk/client-sqs`
- Create SQS service module
- Add environment variables for SQS configuration

#### Step 2: Replace Processing Endpoints
- Create new `/api/queue-document` endpoint
- Create new `/api/queue-legal-document` endpoint
- Remove old processing endpoints
- Update upload handlers to use queue submission

#### Step 3: Implement Real-time Updates  
- Replace polling logic with Supabase Real-time subscriptions
- Update React components to use subscriptions
- Add connection status indicators
- Handle subscription cleanup

#### Step 4: Update UI Components
- Remove processing spinners that rely on polling
- Add real-time status indicators
- Improve error handling for queue failures
- Add queue position/estimated time information

#### Step 5: Configuration & Testing
- Update environment configuration
- Add SQS permissions and policies
- Test end-to-end processing flow
- Performance testing with real document loads

### Phase 3: Infrastructure Setup

#### AWS Resources Required
```yaml
# SQS Queue
ProcessingQueue:
  Type: AWS::SQS::Queue
  Properties:
    QueueName: floucast-document-processing
    VisibilityTimeoutSeconds: 900  # 15 minutes
    MessageRetentionPeriod: 1209600  # 14 days
    ReddrivePolicy:
      deadLetterTargetArn: !GetAtt ProcessingDLQ.Arn
      maxReceiveCount: 3

# Dead Letter Queue  
ProcessingDLQ:
  Type: AWS::SQS::Queue
  Properties:
    QueueName: floucast-document-processing-dlq

# ECS Service (Processing App)
ProcessingService:
  Type: AWS::ECS::Service
  Properties:
    Cluster: !Ref ECSCluster
    TaskDefinition: !Ref ProcessingTaskDef
    DesiredCount: 2
    LaunchType: FARGATE
```

#### Environment Variables
**Processing App**:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
GEMINI_API_KEY=your-gemini-key
AWS_REGION=us-east-1
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/account/floucast-document-processing
PROCESSING_CONCURRENCY=3
```

**Original App (Additional)**:
```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your-access-key
AWS_SECRET_ACCESS_KEY=your-secret-key
SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/account/floucast-document-processing
```

## Benefits of Separation

### 1. Improved Reliability
- **99.9% Success Rate**: Eliminates webhook failures through SQS reliability
- **Automatic Retries**: SQS handles failed processing attempts
- **Dead Letter Queues**: Failed messages are preserved for analysis
- **Real-time Updates**: Users get immediate feedback when processing completes

### 2. Better Scalability  
- **Independent Scaling**: Frontend and processing can scale separately
- **Auto-scaling**: ECS can scale processing based on queue depth
- **Resource Optimization**: Processing containers can use high-memory instances
- **Cost Efficiency**: Pay only for processing resources when needed

### 3. Enhanced Development
- **Faster Deployments**: Frontend changes don't require processing restart
- **Better Testing**: Isolated processing logic easier to test
- **Technology Independence**: Can upgrade AI models without affecting frontend
- **Cleaner Codebase**: Separation of concerns improves maintainability

### 4. Operational Excellence
- **Monitoring**: Dedicated metrics for processing performance
- **Debugging**: Isolated logs make troubleshooting easier  
- **Zero Downtime**: Rolling deployments without affecting uploads
- **Disaster Recovery**: Independent backup/restore strategies

## Migration Timeline

### Week 1-2: Processing App Deployment
- ✅ Processing app is ready for deployment
- Deploy to AWS ECS
- Set up SQS queues and policies
- Configure monitoring and alerting

### Week 3-4: Original App Updates
- Implement SQS integration
- Replace processing endpoints with queue submission
- Add real-time subscriptions for status updates
- Update UI components

### Week 5-6: Testing & Rollout
- End-to-end testing with real documents
- Performance testing under load
- Gradual rollout with monitoring
- Documentation updates

### Week 7: Full Migration
- Complete switch to queue-based processing
- Monitor success rates and performance
- Remove old processing code
- Clean up unused dependencies

## Success Metrics

### Reliability Improvements
- **Processing Success Rate**: Target >99.5% (from ~70%)
- **User Notification Time**: <30 seconds after processing complete
- **Queue Processing Time**: <5 minutes average for standard documents

### Cost Reductions
- **Operational Overhead**: Reduce from $3,000-6,000 to <$500/month
- **Development Velocity**: 50% faster feature development
- **Infrastructure Costs**: 30% reduction through auto-scaling

### User Experience
- **Real-time Updates**: Users see progress immediately
- **Faster Uploads**: No processing blocking upload completion
- **Better Error Handling**: Clear feedback for failed processing

## Risk Mitigation

### Deployment Risks
- **Blue-Green Deployment**: Maintain old system during migration
- **Feature Flags**: Gradual rollout of new queue system
- **Rollback Plan**: Quick revert to direct processing if needed

### Data Risks  
- **Queue Message Validation**: Strict schema validation
- **Database Consistency**: Transaction boundaries for atomic updates
- **Backup Strategy**: Regular database snapshots during migration

### Performance Risks
- **Load Testing**: Test with 10x current document volume
- **Auto-scaling Limits**: Set reasonable bounds to prevent cost spikes
- **Circuit Breakers**: Graceful degradation under high load

## Conclusion

This separation plan addresses the major reliability and scalability issues in the current system while positioning Floucast for future growth. The processing app is already built and ready for deployment, making the migration low-risk and high-value.

The key to success will be the careful implementation of SQS integration and real-time updates in the original app, ensuring users have a seamless experience while benefiting from dramatically improved reliability.