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
  LOG_LEVEL: 'info'
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
      tempDir: process.env.TEMP_DIR || '/tmp'
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
