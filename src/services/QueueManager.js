const AWS = require('aws-sdk');
const { v4: uuidv4 } = require('uuid');
const { getConfig } = require('../utils/environment');

class QueueManager {
  constructor({ documentProcessor, logger }) {
    this.documentProcessor = documentProcessor;
    this.logger = logger;
    this.config = getConfig();
    this.sqs = null;
    this.isRunning = false;
    this.workers = [];
    this.processingJobs = new Set();
    
    // Initialize SQS if queue URL is provided
    if (this.config.aws.sqsQueueUrl) {
      this.sqs = new AWS.SQS({ region: this.config.aws.region });
      this.logger.info('SQS client initialized');
    } else {
      this.logger.warn('No SQS queue URL provided, running without queue');
    }
  }

  async start() {
    this.isRunning = true;
    this.logger.info('Queue manager starting...');
    
    if (!this.sqs) {
      this.logger.warn('No SQS configuration, queue manager running in standalone mode');
      return;
    }
    
    // Start multiple worker processes for concurrent processing
    const concurrency = this.config.processing.concurrency;
    
    for (let i = 0; i < concurrency; i++) {
      const worker = this.startWorker(i);
      this.workers.push(worker);
    }
    
    this.logger.info(`Queue manager started with ${concurrency} workers`);
  }

  async startWorker(workerId) {
    this.logger.info(`[Worker-${workerId}] Starting worker`);
    
    const worker = {
      id: workerId,
      isRunning: true
    };
    
    // Start polling loop
    setImmediate(() => this.pollQueue(worker));
    
    return worker;
  }

  async pollQueue(worker) {
    while (this.isRunning && worker.isRunning) {
      try {
        // Poll SQS for new messages
        const messages = await this.sqs.receiveMessage({
          QueueUrl: this.config.aws.sqsQueueUrl,
          MaxNumberOfMessages: 1,           // Process one at a time per worker
          WaitTimeSeconds: 20,              // Long polling
          MessageAttributeNames: ['All'],
          VisibilityTimeout: Math.floor(this.config.processing.maxTimeMs / 1000) // Convert to seconds
        }).promise();

        if (messages.Messages && messages.Messages.length > 0) {
          const message = messages.Messages[0];
          await this.processMessage(message, worker);
        }
      } catch (error) {
        this.logger.error(`[Worker-${worker.id}] Queue polling error:`, error);
        // Wait before retrying on error
        await this.sleep(30000);
      }
    }
    
    this.logger.info(`[Worker-${worker.id}] Worker stopped`);
  }

  async processMessage(message, worker) {
    const jobId = message.MessageId;
    const startTime = Date.now();
    
    try {
      const messageBody = JSON.parse(message.Body);
      
      // Handle S3 event notifications
      if (messageBody.Records && messageBody.Records[0] && messageBody.Records[0].s3) {
        const s3Record = messageBody.Records[0].s3;
        const s3Key = decodeURIComponent(s3Record.object.key.replace(/\+/g, ' '));
        const bucketName = s3Record.bucket.name;
        
        // Extract metadata from message attributes
        const documentId = message.MessageAttributes?.documentId?.StringValue || this.generateDocumentId(s3Key);
        const vertical = message.MessageAttributes?.vertical?.StringValue || 'accounting';
        const organizationId = message.MessageAttributes?.organizationId?.StringValue || 'default';
        
        // Extract file information from S3 key and metadata
        const originalFilename = this.extractFilename(s3Key);
        const documentType = this.detectDocumentType(originalFilename);
        
        const jobData = {
          s3Key,
          bucketName,
          documentId,
          vertical,
          organizationId,
          originalFilename,
          documentType,
          fileSize: s3Record.object.size,
          s3EventName: messageBody.Records[0].eventName
        };
        
        this.logger.info(`[Worker-${worker.id}] Processing S3 event`, {
          jobId,
          s3Key,
          documentId,
          vertical,
          organizationId
        });
        
        // Add to processing set
        this.processingJobs.add(jobId);
        
        // Process the document
        const result = await this.documentProcessor.processDocument(jobData);
        
        // Remove from processing set
        this.processingJobs.delete(jobId);
        
        const processingTime = Date.now() - startTime;
        this.logger.info(`[Worker-${worker.id}] Job completed successfully`, {
          jobId,
          documentId,
          processingTime,
          result: result.success
        });
        
      } else {
        // Handle legacy direct job data format (for backward compatibility)
        const actualJobData = messageBody.Message ? JSON.parse(messageBody.Message) : messageBody;
        const { documentId, vertical, organizationId } = actualJobData;
        
        if (!documentId || !vertical) {
          throw new Error('Invalid job data: missing documentId or vertical');
        }
        
        this.logger.info(`[Worker-${worker.id}] Processing legacy job format`, {
          jobId,
          documentId,
          vertical,
          organizationId
        });

        // Track active processing
        this.processingJobs.add(jobId);

        // Set processing timeout
        const timeoutId = setTimeout(() => {
          this.logger.error(`[Worker-${worker.id}] Job timeout after ${this.config.processing.maxTimeMs}ms`, {
            jobId,
            documentId
          });
        }, this.config.processing.maxTimeMs);

        // Process the document using the same logic as Vercel
        const result = await this.documentProcessor.processDocument(actualJobData);

        clearTimeout(timeoutId);
        this.processingJobs.delete(jobId);

        // Calculate processing time
        const processingTime = Date.now() - startTime;
        
        this.logger.info(`[Worker-${worker.id}] Legacy job completed successfully`, {
          jobId,
          documentId,
          processingTime,
          status: 'completed'
        });
      }

      // Delete message from queue on success
      await this.sqs.deleteMessage({
        QueueUrl: this.config.aws.sqsQueueUrl,
        ReceiptHandle: message.ReceiptHandle
      }).promise();

      this.logger.info(`[Worker-${worker.id}] Message deleted from queue`, { jobId });

    } catch (error) {
      this.logger.error(`[Worker-${worker.id}] Job processing failed:`, error);
      
      // Don't delete message - let it retry or go to DLQ
      // SQS will handle retries based on queue configuration
      
      const processingTime = Date.now() - startTime;
      this.logger.error(`[Worker-${worker.id}] Job failed after ${processingTime}ms`, {
        jobId,
        error: error.message,
        stack: error.stack
      });
      
    } finally {
      // Cleanup tracking
      this.processingJobs.delete(jobId);
    }
  }

  // Helper methods for S3 event processing
  generateDocumentId(s3Key) {
    // Generate document ID from S3 key or use UUID
    const keyParts = s3Key.split('/');
    const filename = keyParts[keyParts.length - 1];
    const nameWithoutExt = filename.split('.')[0];
    
    // If the filename looks like it has an ID, use it, otherwise generate UUID
    if (nameWithoutExt.length > 8 && /^[a-zA-Z0-9\-_]+$/.test(nameWithoutExt)) {
      return nameWithoutExt;
    }
    
    return `doc-${uuidv4()}`;
  }

  extractFilename(s3Key) {
    // Extract original filename from S3 key
    const keyParts = s3Key.split('/');
    return keyParts[keyParts.length - 1];
  }

  detectDocumentType(filename) {
    // Detect document MIME type from filename extension
    const ext = filename.toLowerCase().split('.').pop();
    
    const mimeTypes = {
      'pdf': 'application/pdf',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'heic': 'image/heic',
      'heif': 'image/heif',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xls': 'application/vnd.ms-excel',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'doc': 'application/msword',
      'txt': 'text/plain'
    };

    return mimeTypes[ext] || 'application/octet-stream';
  }

  async stop() {
    this.logger.info('Queue manager stopping...');
    this.isRunning = false;
    
    // Stop all workers
    this.workers.forEach(worker => {
      worker.isRunning = false;
    });
    
    // Wait for active jobs to complete (with timeout)
    const maxWaitTime = 5 * 60 * 1000; // 5 minutes
    const startTime = Date.now();
    
    while (this.processingJobs.size > 0 && (Date.now() - startTime) < maxWaitTime) {
      this.logger.info(`Waiting for ${this.processingJobs.size} active jobs to complete...`);
      await this.sleep(5000);
    }
    
    if (this.processingJobs.size > 0) {
      this.logger.warn(`Force stopping with ${this.processingJobs.size} jobs still processing`);
    }
    
    this.logger.info('Queue manager stopped');
  }

  async getMetrics() {
    const metrics = {
      timestamp: new Date().toISOString(),
      activeJobs: this.processingJobs.size,
      workerCount: this.workers.filter(w => w.isRunning).length,
      totalWorkers: this.workers.length,
      memory: process.memoryUsage(),
      uptime: process.uptime()
    };
    
    // Add SQS metrics if available
    if (this.sqs && this.config.aws.sqsQueueUrl) {
      try {
        const attributes = await this.sqs.getQueueAttributes({
          QueueUrl: this.config.aws.sqsQueueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed'
          ]
        }).promise();
        
        metrics.queue = {
          availableMessages: parseInt(attributes.Attributes.ApproximateNumberOfMessages),
          inFlightMessages: parseInt(attributes.Attributes.ApproximateNumberOfMessagesNotVisible),
          delayedMessages: parseInt(attributes.Attributes.ApproximateNumberOfMessagesDelayed)
        };
      } catch (error) {
        this.logger.warn('Failed to get queue metrics:', error);
        metrics.queue = { error: 'Failed to retrieve queue metrics' };
      }
    } else {
      metrics.queue = { status: 'no_queue_configured' };
    }
    
    return metrics;
  }

  // Manual job processing (for testing or direct invocation)
  async processJob(jobData) {
    if (!jobData.documentId || !jobData.vertical) {
      throw new Error('Invalid job data: missing documentId or vertical');
    }
    
    this.logger.info('Processing manual job', jobData);
    
    try {
      const result = await this.documentProcessor.processDocument(jobData);
      this.logger.info('Manual job completed successfully', {
        documentId: jobData.documentId,
        processingTime: result.processingTime
      });
      return result;
    } catch (error) {
      this.logger.error('Manual job failed:', error);
      throw error;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = QueueManager;