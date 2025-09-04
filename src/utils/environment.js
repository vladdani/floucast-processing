/**
 * Environment variable validation and configuration
 */

const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY', 
  'GEMINI_API_KEY',
  'AWS_REGION',
  'S3_BUCKET_NAME',
  'SQS_QUEUE_URL'
];

const optionalEnvVars = {
  S3_BUCKET_REGION: null, // Uses AWS_REGION if not specified
  SQS_DEAD_LETTER_QUEUE_URL: null,
  PROCESSING_CONCURRENCY: '3',
  MAX_PROCESSING_TIME_MS: '900000', // 15 minutes
  SQS_VISIBILITY_TIMEOUT: '900', // 15 minutes
  SQS_WAIT_TIME_SECONDS: '20', // Long polling
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  
  // Document Processing Configuration
  TEXT_CHUNK_SIZE: '700',
  TEXT_CHUNK_OVERLAP: '100',
  SMALL_DOCUMENT_THRESHOLD: '524288', // 512KB in bytes
  MEDIUM_DOCUMENT_THRESHOLD: '2097152', // 2MB in bytes
  
  // Image Processing Configuration  
  IMAGE_RESIZE_WIDTH: '1920',
  IMAGE_RESIZE_HEIGHT: '1920',
  
  // Request Configuration
  REQUEST_BODY_LIMIT: '100mb',
  
  // File Processing Configuration
  MAX_EMBEDDING_BATCH_SIZE: '10'
};

function validateEnvironment() {
  const missing = [];
  const config = {};
  
  // Check required environment variables
  for (const envVar of requiredEnvVars) {
    const value = process.env[envVar];
    if (!value || value.trim() === '') {
      missing.push(envVar);
    } else {
      config[envVar] = value;
    }
  }
  
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  
  // Set optional environment variables with defaults
  for (const [envVar, defaultValue] of Object.entries(optionalEnvVars)) {
    config[envVar] = process.env[envVar] || defaultValue;
  }
  
  // Validate specific values
  const concurrency = parseInt(config.PROCESSING_CONCURRENCY);
  if (isNaN(concurrency) || concurrency < 1 || concurrency > 10) {
    throw new Error('PROCESSING_CONCURRENCY must be between 1 and 10');
  }
  
  const maxTime = parseInt(config.MAX_PROCESSING_TIME_MS);
  if (isNaN(maxTime) || maxTime < 60000) {
    throw new Error('MAX_PROCESSING_TIME_MS must be at least 60000 (1 minute)');
  }
  
  // Validate URLs
  try {
    new URL(config.SUPABASE_URL);
  } catch (error) {
    throw new Error('SUPABASE_URL must be a valid URL');
  }
  
  return config;
}

function getConfig() {
  return {
    supabase: {
      url: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
    },
    ai: {
      geminiApiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
      embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004'
    },
    aws: {
      region: process.env.AWS_REGION,
      s3BucketName: process.env.S3_BUCKET_NAME,
      s3BucketRegion: process.env.S3_BUCKET_REGION || process.env.AWS_REGION,
      sqsQueueUrl: process.env.SQS_QUEUE_URL,
      sqsDeadLetterQueueUrl: process.env.SQS_DEAD_LETTER_QUEUE_URL,
      sqsVisibilityTimeout: parseInt(process.env.SQS_VISIBILITY_TIMEOUT || '900'),
      sqsWaitTimeSeconds: parseInt(process.env.SQS_WAIT_TIME_SECONDS || '20')
    },
    processing: {
      concurrency: parseInt(process.env.PROCESSING_CONCURRENCY || '3'),
      maxTimeMs: parseInt(process.env.MAX_PROCESSING_TIME_MS || '900000'),
      tempDir: process.env.TEMP_DIR || '/tmp',
      textChunkSize: parseInt(process.env.TEXT_CHUNK_SIZE || '700'),
      textChunkOverlap: parseInt(process.env.TEXT_CHUNK_OVERLAP || '100'),
      smallDocumentThreshold: parseInt(process.env.SMALL_DOCUMENT_THRESHOLD || '524288'),
      mediumDocumentThreshold: parseInt(process.env.MEDIUM_DOCUMENT_THRESHOLD || '2097152'),
      maxEmbeddingBatchSize: parseInt(process.env.MAX_EMBEDDING_BATCH_SIZE || '10')
    },
    server: {
      requestBodyLimit: process.env.REQUEST_BODY_LIMIT || '100mb'
    },
    image: {
      resizeWidth: parseInt(process.env.IMAGE_RESIZE_WIDTH || '1920'),
      resizeHeight: parseInt(process.env.IMAGE_RESIZE_HEIGHT || '1920')
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
      cloudWatch: process.env.NODE_ENV === 'production'
    }
  };
}

module.exports = {
  validateEnvironment,
  getConfig,
  requiredEnvVars,
  optionalEnvVars
};
