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
      this.logger.info('✅ SQS client initialized');
    } else {
      this.logger.warn('⚠️ No SQS queue URL provided, running without queue');
    }
  }

  async start() {
    this.isRunning = true;
    this.logger.info('🚀 Queue manager starting...');
    
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
    
    this.logger.info(`✅ Queue manager started with ${concurrency} workers`);
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
      const jobData = JSON.parse(message.Body);
      
      // Handle both direct job data and SQS wrapped messages
      const actualJobData = jobData.Message ? JSON.parse(jobData.Message) : jobData;
      const { documentId, vertical, organizationId } = actualJobData;
      
      if (!documentId || !vertical) {
        throw new Error('Invalid job data: missing documentId or vertical');
      }
      
      this.logger.info(`[Worker-${worker.id}] Processing job`, {
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
        // Note: The job will still complete but we log the timeout
      }, this.config.processing.maxTimeMs);

      // Process the document using the same logic as Vercel
      const result = await this.documentProcessor.processDocument(actualJobData);

      clearTimeout(timeoutId);

      // Calculate processing time
      const processingTime = Date.now() - startTime;
      
      this.logger.info(`[Worker-${worker.id}] Job completed successfully`, {
        jobId,
        documentId,
        processingTime,
        status: 'completed'
      });

      // Delete message from queue on success
      await this.sqs.deleteMessage({
        QueueUrl: this.config.aws.sqsQueueUrl,
        ReceiptHandle: message.ReceiptHandle
      }).promise();

      return result;

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

  async stop() {
    this.logger.info('🛑 Queue manager stopping...');
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
    
    this.logger.info('✅ Queue manager stopped');
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