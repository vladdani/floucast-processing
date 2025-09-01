# Floucast Document Processor

A containerized document processing service for Floucast, designed to run on AWS ECS with the same AI processing capabilities as the Vercel application.

## Features

- **AI-Powered Processing**: Uses Google Gemini 2.0 Flash for document extraction
- **Multi-Format Support**: PDF, DOCX, XLSX, Images (including HEIC/HEIF conversion)
- **Exact Vercel Parity**: Same processing logic, same results
- **Production Ready**: Health checks, metrics, graceful shutdown
- **Scalable**: Designed for AWS ECS Fargate auto-scaling
- **Queue Processing**: SQS integration for reliable job processing
- **Real-time Updates**: Supabase Real-time integration

## Architecture

```
┌─────────────────┐    ┌───────────────┐    ┌──────────────────┐
│   SQS Queue     │───▶│  ECS Service  │───▶│   Supabase DB    │
│   (Jobs)        │    │  (This App)   │    │   (Results)      │
└─────────────────┘    └───────────────┘    └──────────────────┘
                              │
                              ▼
                       ┌───────────────┐
                       │  Gemini AI    │
                       │  (Processing) │
                       └───────────────┘
```

## Quick Start

### 1. Environment Setup

```bash
cp .env.example .env
# Edit .env with your actual values
```

### 2. Local Development

```bash
npm install
npm run dev
```

### 3. Docker Build & Run

```bash
npm run docker:build
npm run docker:run
```

### 4. Deploy to AWS ECS

```bash
# Build and push to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin {account}.dkr.ecr.us-east-1.amazonaws.com

docker tag floucast-processor:latest {account}.dkr.ecr.us-east-1.amazonaws.com/floucast-processor:latest
docker push {account}.dkr.ecr.us-east-1.amazonaws.com/floucast-processor:latest

# Deploy using ECS CLI or AWS Console
```

## Configuration

### Required Environment Variables

- `SUPABASE_URL`: Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: Service role key for database access
- `GEMINI_API_KEY`: Google Gemini API key for AI processing
- `AWS_REGION`: AWS region for SQS and other services

### Optional Environment Variables

- `SQS_QUEUE_URL`: SQS queue for job processing (if not set, runs in standalone mode)
- `PROCESSING_CONCURRENCY`: Number of concurrent workers (default: 3)
- `MAX_PROCESSING_TIME_MS`: Maximum processing time per document (default: 900000ms)

## API Endpoints

### Health Check
```
GET /health
```
Returns service health status including Supabase, and AI connectivity.

### Metrics
```
GET /metrics
```
Returns processing metrics for monitoring and auto-scaling.

### Manual Processing
```
POST /process
Content-Type: application/json

{
  "documentId": "uuid",
  "vertical": "accounting|legal",
  "organizationId": "uuid"
}
```

## Processing Flow

1. **Job Reception**: Receives job from SQS queue or direct API call
2. **Document Download**: Downloads file from Supabase Storage
3. **Format Detection**: Detects file type and processing strategy
4. **AI Processing**: Uses Gemini AI for text extraction and structured data
5. **Data Processing**: Applies Indonesian number formatting and classification
6. **Embedding Generation**: Creates vector embeddings for search
7. **Results Storage**: Saves processed data to Supabase
8. **Status Updates**: Updates processing status via Supabase Real-time

## File Processing Support

### Document Types
- **PDF**: Text extraction and structured data
- **DOCX**: Microsoft Word document processing
- **XLSX/XLS**: Excel spreadsheet conversion to text
- **Images**: JPEG, PNG, HEIC/HEIF with WebP conversion

### Processing Strategies
- **Small Files (≤500KB)**: Combined AI call for speed
- **Large Files**: Separate text and structured data extraction
- **XLSX Files**: Direct text conversion before AI processing
- **Images**: Format conversion + OCR capabilities

## Monitoring & Observability

### Health Checks
- Container health check every 30 seconds
- Service health endpoint checks all dependencies
- Automatic container replacement on failure

### Metrics
- Queue depth and processing rate
- Memory and CPU usage
- Processing success/failure rates
- Average processing times

### Logging
- Structured JSON logs
- CloudWatch integration in production
- Request/response logging
- Error tracking with stack traces

## Auto-scaling Configuration

The service is designed to work with AWS ECS auto-scaling:

```yaml
# Example auto-scaling targets
- CPU > 70%: Scale up
- Memory > 80%: Scale up  
- Queue depth > 10: Scale up
- Queue empty for 15 minutes: Scale down
```

## Security Features

- Non-root container user
- Minimal base image (Alpine)
- Environment variable validation
- Helmet.js security headers
- Input validation and sanitization

## Development

### Project Structure
```
src/
├── server.js              # Main application entry
├── services/
│   ├── DocumentProcessor.js   # Core processing logic
│   └── QueueManager.js        # SQS queue management
└── utils/
    ├── environment.js         # Environment validation
    └── logger.js             # Logging configuration
```

### Running Tests
```bash
npm test
```

### Adding New File Types
1. Update `DocumentProcessor.isImageFile()` or similar detection methods
2. Add processing logic in `processFileContent()`
3. Update AI prompts if needed for new data types
4. Test with sample files

## Troubleshooting

### Common Issues

1. **Container won't start**
   - Check environment variables are set correctly
   - Verify Supabase and Gemini API keys are valid
   - Check Docker logs: `docker logs <container-id>`

2. **Processing fails**
   - Check file permissions in Supabase Storage
   - Verify document exists in database
   - Check AI API quotas and limits

3. **Queue not processing**
   - Verify SQS queue URL and permissions
   - Check AWS credentials and region
   - Monitor SQS dead letter queue

### Debug Mode
Set `NODE_ENV=development` and `LOG_LEVEL=debug` for verbose logging.

## Performance Tuning

### Container Resources
- **CPU**: 4 vCPU recommended for AI processing
- **Memory**: 16 GB recommended for large documents
- **Storage**: 20 GB for temporary file processing

### Concurrency Settings
- Start with `PROCESSING_CONCURRENCY=3`
- Monitor CPU/memory usage
- Increase up to 5-6 for high-memory instances
- Decrease to 1-2 for smaller instances

## License

MIT License - see LICENSE file for details.
