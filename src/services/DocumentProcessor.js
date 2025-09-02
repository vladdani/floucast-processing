const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const AWS = require('aws-sdk');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const { getConfig } = require('../utils/environment');

// Helper function to parse numbers from AI responses (handles Indonesian and international formats)
function parseNumericValue(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  
  let cleanValue = String(value).trim();
  
  // Handle Indonesian format: 8.319.886,52 (periods for thousands, comma for decimal)
  // vs International format: 8,319,886.52 (commas for thousands, period for decimal)
  
  // Remove any currency symbols and extra spaces
  cleanValue = cleanValue.replace(/[A-Za-z\s$€£¥₹]/g, '');
  
  // Check if this looks like Indonesian format (multiple periods and one comma)
  const periodCount = (cleanValue.match(/\./g) || []).length;
  const commaCount = (cleanValue.match(/,/g) || []).length;
  
  if (periodCount > 1 && commaCount === 1) {
    // Indonesian format: 8.319.886,52 -> 8319886.52
    cleanValue = cleanValue.replace(/\./g, '').replace(',', '.');
  } else if (periodCount === 1 && commaCount > 1) {
    // Reverse Indonesian format with commas as thousands: 8,319,886.52 -> 8319886.52
    cleanValue = cleanValue.replace(/,/g, '');
  } else if (periodCount === 0 && commaCount === 1) {
    // Could be Indonesian decimal: 886,52 -> 886.52
    cleanValue = cleanValue.replace(',', '.');
  } else if (periodCount === 1 && commaCount === 0) {
    // Already in international format: 8319886.52
    // No change needed
  } else {
    // Mixed or unclear format, clean everything except last separator
    // Remove all separators except the last one, assume it's decimal
    const lastPeriod = cleanValue.lastIndexOf('.');
    const lastComma = cleanValue.lastIndexOf(',');
    
    if (lastPeriod > lastComma && lastPeriod > -1) {
      // Last separator is period, treat as decimal
      cleanValue = cleanValue.substring(0, lastPeriod).replace(/[,.]/g, '') + '.' + cleanValue.substring(lastPeriod + 1);
    } else if (lastComma > lastPeriod && lastComma > -1) {
      // Last separator is comma, treat as decimal
      cleanValue = cleanValue.substring(0, lastComma).replace(/[,.]/g, '') + '.' + cleanValue.substring(lastComma + 1);
    } else {
      // No clear decimal separator, remove all separators
      cleanValue = cleanValue.replace(/[,.]/g, '');
    }
  }
  
  // Final cleanup: remove any remaining non-numeric characters except decimal point and minus sign
  cleanValue = cleanValue.replace(/[^0-9.-]/g, '');
  
  if (cleanValue === '' || cleanValue === '-' || cleanValue === '.') {
    return null;
  }
  
  const parsed = parseFloat(cleanValue);
  return isNaN(parsed) ? null : parsed;
}

// Document type normalization function
function normalizeDocumentType(type) {
  if (!type) return null;
  
  // Convert to lowercase for case-insensitive comparison
  const lowerType = type.toLowerCase();
  
  // Remove "Dashboard." prefix if present
  let normalizedType = type.replace(/^Dashboard\./i, '');
  
  // Replace any remaining dots with spaces
  normalizedType = normalizedType.replace(/\./g, ' ');
  
  // Replace underscores with spaces
  normalizedType = normalizedType.replace(/_/g, ' ');
  
  // Handle specific document type normalizations
  if (lowerType.includes('transfer') && lowerType.includes('confirmation')) {
    return 'Transfer Confirmation';
  } else if (lowerType.includes('invoice') || lowerType === 'transaction') {
    return 'Invoice';
  } else if (lowerType.includes('receipt')) {
    return 'Receipt';
  } else if (lowerType.includes('statement') && lowerType.includes('billing')) {
    return 'Billing Statement';
  } else if (lowerType.includes('bank') && lowerType.includes('statement')) {
    return 'Bank Statement';
  } else if (lowerType.includes('bill')) {
    return 'Bill';
  } else if (lowerType.includes('quote') || lowerType.includes('quotation')) {
    return 'Quote';
  } else if (lowerType === 'other') {
    return 'Other';
  }
  
  // For any other types, apply title case format for better readability
  return normalizedType
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Text chunking function (simplified version of accountant-app's recursiveCharacterTextSplitter)
function chunkText(text, options = {}) {
  const { chunkSize = 700, chunkOverlap = 100 } = options;
  const chunks = [];
  
  if (!text || text.length <= chunkSize) {
    return text ? [text] : [];
  }
  
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.substring(start, end);
    chunks.push(chunk);
    
    if (end >= text.length) break;
    start = end - chunkOverlap;
  }
  
  return chunks;
}

// Timeout wrapper to prevent operations from hanging indefinitely
async function withTimeout(promise, timeoutMs, errorMessage = 'Operation timed out') {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  
  return Promise.race([promise, timeoutPromise]);
}

// Retry wrapper for AI calls
async function withRetry(fn, retries = 3, delay = 1000) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Retry only on 5xx server errors
      if (error.status && error.status >= 500 && error.status <= 599) {
        console.warn(`Attempt ${i + 1} failed with status ${error.status}. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay * (i + 1))); // Exponential backoff
      } else {
        // Don't retry on client errors (4xx) or other issues
        throw error;
      }
    }
  }
  throw lastError;
}

class DocumentProcessor {
  constructor({ logger }) {
    this.logger = logger;
    this.config = getConfig();
    this.supabase = null;
    this.genAI = null;
    this.s3 = null;
    this.extractionModel = null;
    this.embeddingModel = null;
  }

  async initialize() {
    this.logger.info('Initializing DocumentProcessor services...');
    
    // Initialize Supabase
    this.supabase = createClient(
      this.config.supabase.url,
      this.config.supabase.serviceRoleKey
    );
    
    // Initialize AWS S3
    this.s3 = new AWS.S3({ region: this.config.aws.s3BucketRegion });
    this.logger.info('S3 client initialized');
    
    // Initialize Gemini AI
    this.genAI = new GoogleGenerativeAI(this.config.ai.geminiApiKey);
    this.extractionModel = this.genAI.getGenerativeModel({ 
      model: this.config.ai.model 
    });
    this.embeddingModel = this.genAI.getGenerativeModel({ 
      model: this.config.ai.embeddingModel 
    });
    
    
    this.logger.info('DocumentProcessor initialized successfully');
  }

  async processDocument(jobData) {
    const { s3Key, bucketName, documentId, vertical, organizationId, originalFilename, documentType, fileSize } = jobData;
    const startTime = Date.now();
    
    this.logger.info(`[${documentId}] Starting enhanced S3 document processing`, {
      s3Key,
      bucketName,
      documentId,
      vertical,
      organizationId,
      originalFilename,
      fileSize
    });

    try {
      // Step 1: Create/fetch document record from S3 metadata
      const document = await this.createOrFetchDocument({
        documentId,
        s3Key,
        bucketName,
        originalFilename,
        documentType,
        fileSize,
        vertical,
        organizationId
      });
      await this.emitProcessingStatus(documentId, 'processing', 10);

      // Step 2: Download file from S3
      const fileBuffer = await this.downloadFileFromS3(bucketName, s3Key);
      await this.emitProcessingStatus(documentId, 'processing', 25);

      // Step 3: Process file content using accountant-app logic
      const processingResult = await this.processFileContentEnhanced(
        documentId, 
        fileBuffer, 
        document, 
        startTime
      );
      await this.emitProcessingStatus(documentId, 'processing', 90);

      // Step 4: Update final document status
      await this.updateDocumentWithResults(documentId, processingResult, startTime);
      await this.emitProcessingStatus(documentId, 'complete', 100);

      const processingTime = Date.now() - startTime;
      this.logger.info(`[${documentId}] Enhanced processing completed successfully`, {
        documentId,
        processingTime,
        status: 'complete',
        extractedData: !!processingResult.extractedData,
        embeddings: processingResult.embeddingsCount || 0
      });

      return {
        success: true,
        documentId,
        processingTime,
        result: processingResult
      };

    } catch (error) {
      this.logger.error(`[${documentId}] Enhanced processing failed:`, error);
      await this.handleProcessingError(documentId, error, startTime);
      throw error;
    }
  }

  // Enhanced file content processing using accountant-app logic
  async processFileContentEnhanced(documentId, fileBuffer, document, startTime) {
    const filename = document.original_filename || document.file_path;
    const fileType = filename.split('.').pop()?.toLowerCase();
    const fileSizeKB = Math.round(fileBuffer.byteLength / 1024);
    const fileSizeMB = fileSizeKB / 1024;
    
    // Performance optimization thresholds (from accountant-app)
    const SMALL_DOC_THRESHOLD = 500 * 1024; // 500KB
    const MEDIUM_DOC_THRESHOLD = 2 * 1024 * 1024; // 2MB
    const isSmallDocument = fileBuffer.byteLength < SMALL_DOC_THRESHOLD;
    const isMediumDocument = fileBuffer.byteLength < MEDIUM_DOC_THRESHOLD;
    
    this.logger.info(`[${documentId}] File analysis: ${fileSizeKB}KB (${fileSizeMB.toFixed(1)}MB) - Strategy: ${isSmallDocument ? 'FAST' : isMediumDocument ? 'STANDARD' : 'COMPREHENSIVE'}`);
    
    // Check file types
    const isXlsxFile = ['xlsx', 'xls'].includes(fileType);
    const isImageFile = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(fileType);
    const isLikelyBankStatement = this.detectBankStatement(filename, document.document_type);
    
    const mimeType = this.getMimeType(fileType);
    
    let fullDocumentText = null;
    let extractedData = null;
    let skipStructuredExtraction = false;
    
    // Handle XLSX files first
    if (isXlsxFile) {
      this.logger.info(`[${documentId}] Processing XLSX file`);
      fullDocumentText = await this.xlsxToText(fileBuffer);
      
      if (fullDocumentText) {
        this.logger.info(`[${documentId}] Successfully converted XLSX to text (${fullDocumentText.length} characters)`);
      } else {
        this.logger.warn(`[${documentId}] Failed to extract text from XLSX file`);
      }
    }
    
    // Enhanced AI extraction strategy (from accountant-app)
    if (isSmallDocument && !isXlsxFile) {
      // Combined AI call for small documents (performance optimization)
      this.logger.info(`[${documentId}] Using combined AI extraction for small document`);
      
      try {
        const combinedResult = await this.performCombinedAIExtraction(fileBuffer, mimeType, documentId);
        if (combinedResult.fullText) fullDocumentText = combinedResult.fullText;
        if (combinedResult.extractedData) {
          extractedData = combinedResult.extractedData;
          skipStructuredExtraction = true;
        }
      } catch (error) {
        this.logger.warn(`[${documentId}] Combined AI extraction failed, falling back to separate calls:`, error);
      }
    }
    
    // Full text extraction if not done yet
    if (!fullDocumentText && !isXlsxFile) {
      this.logger.info(`[${documentId}] Starting AI full text extraction`);
      fullDocumentText = await this.extractFullText(fileBuffer, mimeType);
    }
    
    // Critical check: If full text extraction failed, stop processing
    if (!fullDocumentText) {
      throw new Error('Full text extraction failed to produce content. The document might be empty, corrupted, or unsupported.');
    }
    
    // Structured data extraction
    if (!skipStructuredExtraction) {
      this.logger.info(`[${documentId}] Starting AI structured data extraction`);
      await this.emitProcessingStatus(documentId, 'processing', 50);
      
      extractedData = await this.extractStructuredData(
        fileBuffer, 
        mimeType, 
        filename, 
        isXlsxFile ? fullDocumentText : null,
        isLikelyBankStatement
      );
    }
    
    // Process and clean extracted data
    if (extractedData) {
      extractedData = this.processExtractedData(extractedData);
    }
    
    // Generate embeddings
    const embeddings = await this.generateEnhancedEmbeddings(fullDocumentText, documentId, isSmallDocument);
    
    return {
      fullDocumentText,
      extractedData,
      embeddings,
      embeddingsCount: embeddings.length,
      processingTime: Date.now() - startTime
    };
  }
  
  // Helper method to detect bank statements
  detectBankStatement(filename, documentType) {
    const lowerFilename = filename.toLowerCase();
    return (lowerFilename.includes('bank') && lowerFilename.includes('statement')) ||
           lowerFilename.includes('rekening') || // Indonesian for account/statement
           (documentType && documentType.toLowerCase().includes('bank statement'));
  }
  
  // Helper method to get MIME type
  getMimeType(fileType) {
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
      'xls': 'application/vnd.ms-excel'
    };
    
    return mimeTypes[fileType] || 'application/octet-stream';
  }
    
    let xlsxExtractedText = null;
    let imagePreviewPath = null;

    // Excel Processing - using secure ExcelJS
    if (isXlsxFile) {
      this.logger.info(`[${documentId}] Processing Excel file`);
      xlsxExtractedText = await this.xlsxToText(fileBuffer);
    }

    // Image Processing - EXACT same as Vercel  
    const isImageFile = this.isImageFile(document.document_type, document.original_filename);
    if (isImageFile) {
      this.logger.info(`[${documentId}] Processing image file`);
      imagePreviewPath = await this.processImageFile(documentId, fileBuffer, document);
    }

    // Determine processing strategy based on file size - EXACT same logic
    const fileSize = fileBuffer.length;
    const isSmallFile = fileSize <= 500000; // 500KB threshold

    let aiExtractedData, fullTextContent;

    if (isSmallFile) {
      // Fast processing for small files - EXACT same as Vercel
      const combinedResult = await this.processCombinedSmallFile(
        fileBuffer, 
        document, 
        xlsxExtractedText
      );
      aiExtractedData = combinedResult.structuredData;
      fullTextContent = combinedResult.fullText;
    } else {
      // Standard processing for larger files - EXACT same as Vercel
      const results = await Promise.all([
        this.extractFullText(fileBuffer, document, xlsxExtractedText),
        this.extractStructuredData(fileBuffer, document, xlsxExtractedText)
      ]);
      
      fullTextContent = results[0];
      aiExtractedData = results[1];
    }

    // Process extracted data - same line item classification logic
    const processedData = await this.processExtractedData(
      aiExtractedData, 
      vertical, 
      documentId
    );

    return {
      extractedText: fullTextContent,
      structuredData: processedData,
      imagePreviewPath,
      processingStrategy: isSmallFile ? 'fast' : 'standard'
    };
  }

  async processCombinedSmallFile(fileBuffer, document, xlsxText) {
    const base64Data = fileBuffer.toString('base64');
    const mimeType = document.document_type || 'application/pdf';
    
    const combinedPrompt = `Analyze this document and provide both full text extraction and structured data extraction.

RESPOND WITH THIS EXACT FORMAT:
=== FULL TEXT ===
[Extract all text content here]

=== STRUCTURED DATA ===
{
  "vendor_name": "string",
  "document_type": "invoice|receipt|bank_statement|contract|other",
  "document_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "total_amount": number,
  "tax_amount": number,
  "currency": "string",
  "line_items": [
    {
      "description": "string",
      "quantity": number,
      "unit_price": number,
      "line_total_amount": number,
      "tax_rate": number
    }
  ],
  "bank_transactions": []
}

${xlsxText ? `Additional spreadsheet data to consider: ${xlsxText.substring(0, 2000)}` : ''}`;

    try {
      const result = await this.extractionModel.generateContent([
        { text: combinedPrompt },
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Data
          }
        }
      ]);

      const responseText = result.response.text();
      
      // Parse response sections
      const fullTextMatch = responseText.match(/=== FULL TEXT ===\n(.*?)\n=== STRUCTURED DATA ===/s);
      const structuredMatch = responseText.match(/=== STRUCTURED DATA ===\n(.*?)$/s);
      
      const fullText = fullTextMatch ? fullTextMatch[1].trim() : '';
      let structuredData = this.getDefaultStructuredData();
      
      if (structuredMatch) {
        try {
          const jsonMatch = structuredMatch[1].match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            structuredData = JSON.parse(jsonMatch[0]);
          }
        } catch (parseError) {
          this.logger.warn('Failed to parse structured data from combined response:', parseError);
        }
      }
      
      return { fullText, structuredData };
    } catch (error) {
      this.logger.error('Combined small file processing failed:', error);
      return {
        fullText: xlsxText || 'Text extraction failed',
        structuredData: this.getDefaultStructuredData()
      };
    }
  }

  async extractFullText(fileBuffer, document, xlsxText = null) {
    const base64Data = fileBuffer.toString('base64');
    const mimeType = document.document_type || 'application/pdf';
    
    const fullTextPrompt = xlsxText ? 
      `Extract all text content from this document. The document also contains spreadsheet data: ${xlsxText.substring(0, 2000)}` :
      "Extract all text content from the provided document, preserving structure and formatting where possible.";

    try {
      const result = await this.extractionModel.generateContent([
        { text: fullTextPrompt },
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Data
          }
        }
      ]);

      return result.response.text();
    } catch (error) {
      this.logger.error('Full text extraction failed:', error);
      return xlsxText || "Text extraction failed";
    }
  }

  async extractStructuredData(fileBuffer, document, xlsxText = null) {
    const base64Data = fileBuffer.toString('base64');
    const mimeType = document.document_type || 'application/pdf';
    
    // EXACT same prompt as Vercel
    const structuredPrompt = `Analyze this document and extract structured accounting data. Return ONLY valid JSON with the following structure:
{
  "vendor_name": "string",
  "document_type": "invoice|receipt|bank_statement|contract|other",
  "document_date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null", 
  "total_amount": number,
  "tax_amount": number,
  "currency": "string",
  "line_items": [
    {
      "description": "string",
      "quantity": number,
      "unit_price": number,
      "line_total_amount": number,
      "tax_rate": number
    }
  ],
  "bank_transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "string", 
      "amount": number,
      "balance": number,
      "transaction_type": "debit|credit"
    }
  ]
}

${xlsxText ? `Additional spreadsheet data: ${xlsxText.substring(0, 1000)}` : ''}`;

    try {
      const result = await this.extractionModel.generateContent([
        { text: structuredPrompt },
        {
          inlineData: {
            mimeType: mimeType,
            data: base64Data
          }
        }
      ]);

      const responseText = result.response.text();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return this.getDefaultStructuredData();
    } catch (error) {
      this.logger.error('Structured data extraction failed:', error);
      return this.getDefaultStructuredData();
    }
  }

  async processExtractedData(aiExtractedData, vertical, documentId) {
    // Process numeric values using Indonesian format handling
    if (aiExtractedData.total_amount) {
      aiExtractedData.total_amount = this.parseNumericValue(aiExtractedData.total_amount);
    }
    if (aiExtractedData.tax_amount) {
      aiExtractedData.tax_amount = this.parseNumericValue(aiExtractedData.tax_amount);
    }

    // Process line items
    if (aiExtractedData.line_items && Array.isArray(aiExtractedData.line_items)) {
      aiExtractedData.line_items = aiExtractedData.line_items.map(item => ({
        ...item,
        quantity: this.parseNumericValue(item.quantity) || 1,
        unit_price: this.parseNumericValue(item.unit_price),
        line_total_amount: this.parseNumericValue(item.line_total_amount),
        tax_rate: this.parseNumericValue(item.tax_rate) || 0
      }));
    }

    // Process bank transactions
    if (aiExtractedData.bank_transactions && Array.isArray(aiExtractedData.bank_transactions)) {
      aiExtractedData.bank_transactions = aiExtractedData.bank_transactions.map(transaction => ({
        ...transaction,
        amount: this.parseNumericValue(transaction.amount),
        balance: this.parseNumericValue(transaction.balance)
      }));
    }

    return aiExtractedData;
  }

  // EXACT same Indonesian number parsing as Vercel  
  parseNumericValue(value) {
    if (typeof value === 'number') return value;
    if (!value || typeof value !== 'string') return null;

    let cleanValue = value.toString()
      .replace(/[^\d.,\-]/g, '')
      .trim();

    if (!cleanValue) return null;

    const periodCount = (cleanValue.match(/\./g) || []).length;
    const commaCount = (cleanValue.match(/,/g) || []).length;

    // Indonesian format: 8.319.886,52 (periods for thousands, comma for decimal)
    if (periodCount > 1 && commaCount === 1) {
      cleanValue = cleanValue.replace(/\./g, '').replace(',', '.');
    }
    // International format: 8,319,886.52 (commas for thousands, period for decimal)
    else if (commaCount > 1 && periodCount <= 1) {
      cleanValue = cleanValue.replace(/,/g, '');
    }
    // Single comma (could be decimal separator)
    else if (commaCount === 1 && periodCount === 0) {
      cleanValue = cleanValue.replace(',', '.');
    }

    const parsed = parseFloat(cleanValue);
    return isNaN(parsed) ? null : parsed;
  }

  // Image processing - EXACT same as Vercel
  async processImageFile(documentId, fileBuffer, document) {
    try {
      const fileName = document.original_filename;
      const mimeType = document.document_type.toLowerCase();
      const isHeic = mimeType.includes('heic') || mimeType.includes('heif') ||
                     fileName.toLowerCase().endsWith('.heic') || fileName.toLowerCase().endsWith('.heif');
      
      let webpBuffer;
      
      if (isHeic) {
        // Convert HEIC to JPEG first
        const jpegArrayBuffer = await heicConvert({
          buffer: fileBuffer,
          format: 'JPEG',
          quality: 0.85
        });
        const jpegBuffer = Buffer.from(jpegArrayBuffer);
        
        // Then convert to WebP
        webpBuffer = await sharp(jpegBuffer)
          .webp({ quality: 85, effort: 4, lossless: false })
          .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();
      } else {
        // Direct conversion to WebP
        webpBuffer = await sharp(fileBuffer)
          .webp({ quality: 85, effort: 4, lossless: false })
          .resize(1920, 1920, { fit: 'inside', withoutEnlargement: true })
          .toBuffer();
      }

      // Upload to Supabase Storage
      const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
      const previewFileName = `${nameWithoutExt}_preview.webp`;
      const previewPath = `documents/${documentId}/${previewFileName}`;

      const { error: uploadError } = await this.supabase.storage
        .from('documents')
        .upload(previewPath, webpBuffer, {
          contentType: 'image/webp',
          upsert: true
        });

      if (uploadError) {
        this.logger.error('Preview upload failed:', uploadError);
        return null;
      }

      return previewPath;
    } catch (error) {
      this.logger.error('Image processing failed:', error);
      return null;
    }
  }

  // Excel processing using secure ExcelJS
  async xlsxToText(fileBuffer) {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(fileBuffer);
      let allText = '';
      
      workbook.worksheets.forEach(worksheet => {
        allText += `\n=== Sheet: ${worksheet.name} ===\n`;
        
        worksheet.eachRow((row, rowNumber) => {
          const rowValues = [];
          row.eachCell((cell, colNumber) => {
            // Get the display text of the cell
            const cellValue = cell.text || cell.value || '';
            rowValues.push(cellValue.toString());
          });
          
          const rowText = rowValues.join('\t');
          if (rowText.trim()) allText += rowText + '\n';
        });
      });
      
      return allText;
    } catch (error) {
      this.logger.error('Excel processing failed:', error);
      return null;
    }
  }

  isImageFile(mimeType, fileName) {
    const imageMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'];
    
    if (mimeType && imageMimeTypes.includes(mimeType.toLowerCase())) return true;
    if (fileName) {
      const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
      return imageExtensions.includes(ext);
    }
    
    return false;
  }

  async generateEmbeddings(documentId, text, vertical) {
    if (!text || text.length < 50) return;
    
    try {
      // Chunk text for embedding
      const chunks = this.chunkText(text, 700, 100);
      const embeddings = [];
      
      for (let i = 0; i < chunks.length; i++) {
        try {
          const result = await this.embeddingModel.embedContent(chunks[i]);
          embeddings.push({
            content: chunks[i],
            embedding: result.embedding.values,
            chunk_index: i
          });
        } catch (error) {
          this.logger.warn(`Embedding generation failed for chunk ${i}:`, error);
        }
      }
      
      if (embeddings.length > 0) {
        // Save embeddings to database
        const tableName = vertical === 'legal' ? 'legal_document_chunks' : 'document_chunks';
        const documentIdField = vertical === 'legal' ? 'legal_document_id' : 'document_id';
        
        const embeddingRecords = embeddings.map(emb => ({
          [documentIdField]: documentId,
          content: emb.content,
          embedding: emb.embedding,
          chunk_index: emb.chunk_index,
          source_type: 'content'
        }));
        
        const { error } = await this.supabase
          .from(tableName)
          .insert(embeddingRecords);
        
        if (error) {
          this.logger.error('Failed to save embeddings:', error);
        } else {
          this.logger.info(`Saved ${embeddings.length} embeddings for document ${documentId}`);
        }
      }
    } catch (error) {
      this.logger.error('Embedding generation failed:', error);
    }
  }

  chunkText(text, chunkSize = 700, overlap = 100) {
    const chunks = [];
    const words = text.split(/\s+/);
    
    for (let i = 0; i < words.length; i += chunkSize - overlap) {
      const chunk = words.slice(i, i + chunkSize).join(' ');
      if (chunk.trim()) {
        chunks.push(chunk);
      }
    }
    
    return chunks;
  }

  // Status management
  async updateStatus(documentId, vertical, status, progress, error = null) {
    try {
      const tableName = vertical === 'legal' ? 'legal_documents' : 'documents';
      
      // Update in database - this triggers Supabase Real-time
      const updateData = {
        processing_status: status,
        updated_at: new Date().toISOString()
      };
      
      if (error) updateData.ai_extraction_error = error;
      if (status === 'complete') updateData.processed_at = new Date().toISOString();
      
      await this.supabase
        .from(tableName)
        .update(updateData)
        .eq('id', documentId);
        
    } catch (updateError) {
      this.logger.error(`Failed to update status for ${documentId}:`, updateError);
    }
  }

  async saveProcessingResults(documentId, vertical, result) {
    const tableName = vertical === 'legal' ? 'legal_documents' : 'documents';
    
    try {
      // Save main document results
      const updateData = {
        ai_extracted_data: result.structuredData,
        processing_strategy: result.processingStrategy,
        processed_at: new Date().toISOString()
      };
      
      if (result.imagePreviewPath) {
        updateData.preview_path = result.imagePreviewPath;
        updateData.preview_format = 'webp';
      }
      
      await this.supabase
        .from(tableName)
        .update(updateData)
        .eq('id', documentId);
      
      // Save line items if present
      if (result.structuredData.line_items && result.structuredData.line_items.length > 0) {
        const lineItems = result.structuredData.line_items.map((item, index) => ({
          document_id: documentId,
          description: item.description || '',
          quantity: item.quantity || 1,
          unit_price: item.unit_price,
          line_total_amount: item.line_total_amount,
          tax_rate: item.tax_rate || 0,
          line_order: index,
          category: 'uncategorized' // Default category
        }));
        
        await this.supabase
          .from('document_line_items')
          .insert(lineItems);
      }
      
      // Save bank transactions if present
      if (result.structuredData.bank_transactions && result.structuredData.bank_transactions.length > 0) {
        const transactions = result.structuredData.bank_transactions.map(transaction => ({
          document_id: documentId,
          transaction_date: transaction.date,
          description: transaction.description,
          amount: transaction.amount,
          balance: transaction.balance,
          transaction_type: transaction.transaction_type
        }));
        
        await this.supabase
          .from('bank_transactions')
          .insert(transactions);
      }
      
    } catch (error) {
      this.logger.error('Failed to save processing results:', error);
      throw error;
    }
  }

  // Enhanced XLSX processing using ExcelJS (secure alternative to vulnerable xlsx)
  async xlsxToText(buffer) {
    try {
      this.logger.info('Parsing XLSX file using ExcelJS...');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      
      let allText = '';
      const worksheets = workbook.worksheets;
      
      this.logger.info(`Found ${worksheets.length} worksheets`);
      
      worksheets.forEach((worksheet, index) => {
        if (index > 0) allText += '\\n\\n';
        allText += `=== SHEET: ${worksheet.name} ===\\n`;
        
        // Convert worksheet to CSV-like format
        const csvData = [];
        worksheet.eachRow((row, rowNumber) => {
          const rowData = [];
          row.eachCell((cell, colNumber) => {
            let cellValue = '';
            if (cell.value !== null && cell.value !== undefined) {
              if (typeof cell.value === 'object' && cell.value.result !== undefined) {
                cellValue = cell.value.result; // Handle formula results
              } else {
                cellValue = cell.value.toString();
              }
            }
            rowData.push(cellValue);
          });
          csvData.push(rowData.join(','));
        });
        
        allText += csvData.join('\\n');
      });
      
      this.logger.info(`Extracted ${allText.length} characters from XLSX`);
      return allText.trim();
    } catch (error) {
      this.logger.error('Error converting XLSX to text:', error);
      return '';
    }
  }

  // Combined AI extraction for small documents (performance optimization from accountant-app)
  async performCombinedAIExtraction(fileBuffer, mimeType, documentId) {
    const combinedPrompt = `You are an expert accountant assistant. Analyze the provided document and extract both the complete text content AND structured information in a single response.

Important: The document may be a handwritten receipt/nota. First perform OCR on the image content. Detect line items even when there are no grid lines or table borders. When quantity is missing, default to quantity=1. Keep one item per visible line. Parse Indonesian number formatting strictly (periods for thousands, comma for decimal) and always return clean numeric values.

Return your response in this EXACT format:

=== FULL TEXT ===
[Extract all text content from the document, preserving formatting like paragraphs and line breaks]

=== STRUCTURED DATA ===
[JSON object with the structured data fields listed below]

For the structured data JSON, extract these fields:
- vendor (string): The name of the vendor/supplier/seller/customer
- date (string): The primary date in YYYY-MM-DD format
- type (string): Document type (Invoice, Receipt, etc.)
- amount (number): Main total amount as clean number without formatting
- currency (string): 3-letter currency code (IDR, USD, etc.)
- description (string): Concise summary of the document
- document_number (string): Unique identifier/number
- tax_amount (number): Tax amount as clean number
- tax_type_name (string): Tax type name (PPN, VAT, etc.)
- service_charge_amount (number): Service charge as clean number
- service_charge_type (string): Service charge type
- due_date (string): Due date in YYYY-MM-DD format
- ap_ar_status ('AP' | 'AR' | 'N/A'): Payment status
- line_items: Array of line items with description, quantity, unit_price, line_total_amount
- discount (number): Discount amount as clean number
- deposit_amount (number): Deposit amount as clean number

CRITICAL: Return ALL numbers as clean values without formatting (e.g., 136000 not "136.000,00").`;

    const textPart = { text: combinedPrompt };
    const filePart = {
      inlineData: {
        data: this.bufferToBase64(fileBuffer),
        mimeType: mimeType,
      },
    };

    this.logger.info(`[${documentId}] Calling combined AI extraction...`);
    const result = await withTimeout(
      this.extractionModel.generateContent({
        contents: [{ role: "user", parts: [textPart, filePart] }],
      }),
      90000, // 90 seconds for combined extraction
      'Combined AI extraction timed out'
    );

    const response = result.response;
    if (response && response.candidates && response.candidates[0].content) {
      const combinedText = response.text();
      this.logger.info(`[${documentId}] Combined AI extraction completed`);

      // Parse the combined response
      const fullTextMatch = combinedText.match(/=== FULL TEXT ===\\s*([\\s\\S]*?)\\s*=== STRUCTURED DATA ===/);
      const structuredDataMatch = combinedText.match(/=== STRUCTURED DATA ===\\s*([\\s\\S]*?)$/);

      let fullText = null;
      let extractedData = null;

      if (fullTextMatch && fullTextMatch[1]) {
        fullText = fullTextMatch[1].trim();
        this.logger.info(`[${documentId}] Extracted full text (${fullText.length} chars) from combined response`);
      }

      if (structuredDataMatch && structuredDataMatch[1]) {
        try {
          const jsonMatch = structuredDataMatch[1].match(/\\{[\\s\\S]*\\}/);
          if (jsonMatch) {
            extractedData = JSON.parse(jsonMatch[0]);
            
            // Quality check: only use if extraction is comprehensive enough
            const hasLineItems = Array.isArray(extractedData.line_items) && extractedData.line_items.length > 0;
            const hasDescription = typeof extractedData.description === 'string' && extractedData.description.trim().length > 0;
            const hasCoreMeta = extractedData.vendor != null && extractedData.amount != null;
            
            if (hasLineItems || hasDescription || hasCoreMeta) {
              this.logger.info(`[${documentId}] Extracted structured data from combined response (quality OK)`);
            } else {
              extractedData = null; // Quality not good enough, will trigger separate extraction
              this.logger.info(`[${documentId}] Combined extraction quality insufficient, will use separate extraction`);
            }
          }
        } catch (parseError) {
          this.logger.warn(`[${documentId}] Failed to parse structured data from combined response`);
        }
      }

      return { fullText, extractedData };
    }
    
    throw new Error('Combined AI extraction returned empty response');
  }

  // Full text extraction
  async extractFullText(fileBuffer, mimeType) {
    const fullTextPrompt = "Extract all text content from the provided document. If handwriting is present (nota/receipt), perform OCR and preserve line breaks so items remain one per line. Output only the extracted text, no preamble.";
    
    const textPart = { text: fullTextPrompt };
    const filePart = {
      inlineData: {
        data: this.bufferToBase64(fileBuffer),
        mimeType: mimeType,
      },
    };

    const result = await withTimeout(
      this.extractionModel.generateContent({
        contents: [{ role: "user", parts: [textPart, filePart] }],
      }),
      45000, // 45 seconds
      'AI full text extraction timed out'
    );
    
    const response = result.response;
    if (response && response.candidates && response.candidates[0].content) {
      const fullText = response.text();
      this.logger.info(`Successfully extracted full text (length: ${fullText.length})`);
      return fullText;
    } else {
      const blockReason = response?.promptFeedback?.blockReason;
      this.logger.warn(`AI full text extraction response blocked or empty. Reason: ${blockReason}`);
      return null;
    }
  }

  // Structured data extraction with support for bank statements
  async extractStructuredData(fileBuffer, mimeType, filename, xlsxText, isLikelyBankStatement) {
    let extractionPrompt;
    let textPart;
    let imagePart;
    
    if (xlsxText) {
      // For XLSX files, use text-only prompt
      extractionPrompt = `You are an expert accountant assistant. Analyze the following Excel/spreadsheet data and extract structured information:

SPREADSHEET DATA:
${xlsxText}

Based on this spreadsheet data, extract the following fields:`;
      textPart = { text: extractionPrompt };
    } else if (isLikelyBankStatement) {
      // Special handling for bank statements (from accountant-app)
      extractionPrompt = this.getBankStatementPrompt();
      textPart = { text: extractionPrompt };
      imagePart = {
        inlineData: {
          data: this.bufferToBase64(fileBuffer),
          mimeType: mimeType,
        },
      };
    } else {
      // Standard document extraction
      extractionPrompt = this.getStandardExtractionPrompt();
      textPart = { text: extractionPrompt };
      imagePart = {
        inlineData: {
          data: this.bufferToBase64(fileBuffer),
          mimeType: mimeType,
        },
      };
    }

    const contentParts = imagePart ? [textPart, imagePart] : [textPart];

    const result = await withTimeout(
      withRetry(() => this.extractionModel.generateContent({
        contents: [{ role: "user", parts: contentParts }],
      })),
      45000, // 45 seconds
      'AI extraction timed out'
    );

    const response = result.response;
    if (!response || !response.candidates || response.candidates.length === 0 || !response.candidates[0].content) {
      const blockReason = response?.promptFeedback?.blockReason;
      throw new Error(`AI response blocked or empty. Reason: ${blockReason || 'Empty response'}`);
    }

    const extractedJsonString = response.text();
    this.logger.info("AI Extraction Raw Response received");

    // Parse the JSON response safely
    const match = extractedJsonString.match(/\\{[\\s\\S]*\\}/);
    if (match && match[0]) {
      const jsonObjectString = match[0];
      const parsed = JSON.parse(jsonObjectString);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    }
    
    throw new Error('Could not find valid JSON object within AI response');
  }

  // Enhanced embeddings generation
  async generateEnhancedEmbeddings(fullDocumentText, documentId, isSmallDocument) {
    if (!fullDocumentText) {
      this.logger.warn(`[${documentId}] No text for embedding generation`);
      return [];
    }

    try {
      if (isSmallDocument) {
        // Single embedding for small documents (performance optimization)
        this.logger.info(`[${documentId}] Generating single embedding for small document`);
        
        const result = await withTimeout(
          this.embeddingModel.embedContent(fullDocumentText),
          10000,
          'Single embedding generation timed out'
        );
        
        return [{
          text: fullDocumentText,
          embedding: result.embedding.values
        }];
      } else {
        // Chunked embeddings for larger documents
        this.logger.info(`[${documentId}] Generating chunked embeddings`);
        const chunks = chunkText(fullDocumentText, { chunkSize: 700, chunkOverlap: 100 });
        const embeddings = [];
        
        // Batch process embeddings (rate limiting like accountant-app)
        const MAX_CONCURRENT = 10;
        for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
          const batchChunks = chunks.slice(i, Math.min(i + MAX_CONCURRENT, chunks.length));
          
          const batchPromises = batchChunks.map(async (chunk, index) => {
            const globalIndex = i + index;
            try {
              const result = await withTimeout(
                this.embeddingModel.embedContent(chunk),
                10000,
                `Embedding generation timed out for chunk ${globalIndex + 1}`
              );
              return { text: chunk, embedding: result.embedding.values };
            } catch (error) {
              this.logger.warn(`[${documentId}] Failed embedding chunk ${globalIndex + 1}:`, error.message);
              return null;
            }
          });
          
          const batchResults = await Promise.all(batchPromises);
          embeddings.push(...batchResults.filter(result => result !== null));
          
          // Small delay between batches
          if (i + MAX_CONCURRENT < chunks.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
        
        this.logger.info(`[${documentId}] Generated ${embeddings.length}/${chunks.length} embeddings successfully`);
        return embeddings;
      }
    } catch (error) {
      this.logger.error(`[${documentId}] Embedding generation failed:`, error);
      return [];
    }
  }

  // Process and clean extracted data using Indonesian number parsing
  processExtractedData(extractedData) {
    if (!extractedData) return null;

    // Clean numeric values using Indonesian format parsing
    const cleanedData = {
      ...extractedData,
      amount: parseNumericValue(extractedData.amount),
      tax_amount: parseNumericValue(extractedData.tax_amount),
      service_charge_amount: parseNumericValue(extractedData.service_charge_amount),
      discount: parseNumericValue(extractedData.discount),
      deposit_amount: parseNumericValue(extractedData.deposit_amount),
    };

    // Clean line items if present
    if (Array.isArray(extractedData.line_items)) {
      cleanedData.line_items = extractedData.line_items.map(item => ({
        ...item,
        quantity: parseNumericValue(item.quantity),
        unit_price: parseNumericValue(item.unit_price),
        line_total_amount: parseNumericValue(item.line_total_amount),
      }));
    }

    // Clean bank transactions if present
    if (Array.isArray(extractedData.bank_transactions)) {
      cleanedData.bank_transactions = extractedData.bank_transactions.map(transaction => ({
        ...transaction,
        debit_amount: parseNumericValue(transaction.debit_amount),
        credit_amount: parseNumericValue(transaction.credit_amount),
        running_balance: parseNumericValue(transaction.running_balance),
      }));
    }

    // Normalize document type
    cleanedData.type = normalizeDocumentType(extractedData.type);

    return cleanedData;
  }

  // Helper method to convert buffer to base64
  bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return Buffer.from(binary, 'binary').toString('base64');
  }

  // Bank statement extraction prompt (from accountant-app)
  getBankStatementPrompt() {
    return `You are an expert accountant assistant specializing in bank statement analysis. Analyze the provided bank statement image and extract the following information:

BANK STATEMENT SPECIFIC FIELDS:
- vendor (string): The bank name (e.g., "BCA", "Bank Central Asia", "Mandiri", "BNI", etc.)
- date (string): The statement period END date in YYYY-MM-DD format (e.g., if statement is for "January 2022", use "2022-01-31")
- type (string): Always set to "Bank Statement"
- amount (number): null (bank statements don't have a single total amount)
- currency (string): The currency used in the statement (usually "IDR" for Indonesian banks)
- description (string): A summary like "Bank statement for account [account_number] for [period]"
- document_number (string): The account number from the statement
- ap_ar_status (string): null (bank statements are historical records, not payable/receivable items)
- due_date (string): null (bank statements don't have due dates)
- tax_amount (number): null (bank statements don't have tax amounts)
- tax_type_name (string): null (bank statements don't have tax types)
- service_charge_amount (number): null (use individual transaction amounts instead)
- service_charge_type (string): null (use individual transaction types instead)
- discount (number): null (bank statements don't have discounts)
- deposit_amount (number): null (use individual transaction amounts instead)
- line_items: null (do not use for bank statements)
- bank_transactions (array): Extract EACH INDIVIDUAL TRANSACTION with proper banking structure:
  * transaction_date: The transaction date in YYYY-MM-DD format (e.g., "01/01" becomes "2022-01-01" based on statement period)
  * description: The full transaction description/memo (e.g., "KARTU DEBIT TANGGAL: 01/01 SUPER I NDO EXPRESS 6019008511407537")
  * reference_code: Any reference codes, branch codes, or transaction IDs visible (e.g., "6019008511407537", "95031/00000")
  * debit_amount: Amount if it's a debit/withdrawal (money going OUT) - return as CLEAN NUMBER without any formatting (e.g., 387400 not "387.400,00")
  * credit_amount: Amount if it's a credit/deposit (money coming IN) - return as CLEAN NUMBER without any formatting (e.g., 1340000 not "1.340.000,00")
  * running_balance: The account balance after this transaction - return as CLEAN NUMBER without any formatting (e.g., 8319886.52 not "8.319.886,52")
  * transaction_type: The type of transaction (e.g., "KARTU DEBIT", "TRANSFER", "TARIK TUNAI ATM", "E-BANKING", "SALDO AWAL")

CRITICAL INDONESIAN BANKING FORMAT INSTRUCTIONS:
- Indonesian statements use periods (.) as thousands separators and commas (,) as decimal separators
- Example: "8.319.886,52" means 8,319,886.52 in international format
- BUT in your JSON response, return ALL numbers as clean values WITHOUT any separators
- For "8.319.886,52" return: 8319886.52
- For "387.400,00" return: 387400
- For "1.340.000" return: 1340000
- NEVER include commas, periods, or spaces in your numeric responses
- Only return raw numbers that can be parsed directly (e.g., 8319886.52, 387400, 1340000)

IMPORTANT FOR BANK STATEMENTS:
- Extract ALL visible transactions from the statement, including opening balance (SALDO AWAL)
- For debit_amount: Use for transactions that reduce the balance (withdrawals, payments, transfers out)
- For credit_amount: Use for transactions that increase the balance (deposits, transfers in, salary)
- Include full transaction dates in the description for context
- Parse transaction dates relative to the statement period (e.g., "01/01" in January 2022 statement = "2022-01-01")
- Extract complete transaction descriptions including all available details
- Bank statements are historical records only - they don't represent future obligations or receivables

Return the result ONLY as a valid JSON object with these exact keys. Use null for fields that cannot be determined.`;
  }

  // Standard document extraction prompt (from accountant-app)
  getStandardExtractionPrompt() {
    return `You are an expert accountant assistant. Analyze the content of the provided file (image or PDF). Also consider the filename for context. If the document appears handwritten (e.g., nota), perform OCR first and infer line items even without table borders. Extract the following fields:

- vendor (string): CRITICALLY IMPORTANT! The name of the vendor/supplier/seller/customer. 
  * Look for letterhead at the top of the document
  * Check for "From", "Supplier", "Vendor", "Billed from", "Sold by" sections
  * For invoices, look for the company logo, header, or footer information
  * Examine text next to "Pay to" or bank account information
  * NEVER return null for vendor unless absolutely no company/business name appears anywhere
  * If you see multiple potential vendors, choose the one most likely to be the document issuer
  * Extract ONLY the company/business name, not the full address
  * Examples: "Amazon Web Services", "Uber", "Hotel Bali Inda", "LinkedIn Corporation"

- date (string): The primary date on the document (e.g., invoice date, receipt date) in YYYY-MM-DD format.
- type (string): As a senior accountant and admin expert, analyze the ENTIRE document to determine its primary purpose and classify it with the MOST specific and functionally accurate accounting type.
  * Examples: "Invoice", "Receipt", "Purchase Order", "Sales Order", "Bank Statement", etc.
  * Use "Other" ONLY if no specific type can be confidently determined.
- amount (number): The main total amount. Return as CLEAN NUMBER without any formatting (e.g., 136000 not "136.000,00"). For Indonesian documents, remember that periods (.) are thousands separators and commas (,) are decimal separators.
- currency (string): The 3-letter currency code (e.g., 'IDR', 'USD', 'EUR'). Infer if possible, otherwise use null.
- description (string): A concise summary of the document's content and purpose.
- discount (number): The total discount amount. Return as CLEAN NUMBER without formatting. Check for discounts at both the summary level and on individual line items.
- deposit_amount (number): Any deposit or prepayment amount. Return as CLEAN NUMBER without formatting. Use null if no deposit is mentioned.
- document_number (string): The unique identifier for this document (e.g., invoice number, bill number).
- tax_amount (number): The tax amount as CLEAN NUMBER without formatting. Handle Indonesian number formatting where periods are thousands separators.
- tax_type_name (string): The exact name/type of tax as written in the document (e.g., "PPN", "VAT", "GST", "PPh 21", "Sales Tax"). Extract exactly as shown, don't calculate or assume.
- service_charge_amount (number): The service charge amount as CLEAN NUMBER without formatting. Look for "Service Charge", "Service Fee", "Delivery Fee", "Admin Fee", "Processing Fee", "Handling Fee", "Convenience Fee", "Booking Fee", "Gratuity", "Cover Charge", "Surcharge", etc.
- service_charge_type (string): The exact name/type of service charge as written in the document (e.g., "Service Charge", "Delivery Fee", "Admin Fee", "Processing Fee"). Extract exactly as shown, don't calculate or assume.
- due_date (string): The payment due date in YYYY-MM-DD format.
- ap_ar_status ('AP' | 'AR' | 'N/A'): 'AP' if money is owed by the user, 'AR' if owed to the user, 'N/A' for other documents.
- line_items (array of objects, can be null): Individual line items with description, quantity, unit_price, and line_total_amount. For handwritten notas: detect one item per line; if quantity missing, use 1; infer unit_price from line total when necessary. Return ALL numeric values as CLEAN NUMBERS without formatting.

CRITICAL INDONESIAN NUMBER FORMAT INSTRUCTIONS:
- Indonesian documents use periods (.) as thousands separators and commas (,) as decimal separators
- Example: "136.000,50" means 136,000.50 in international format
- BUT in your JSON response, return ALL numbers as clean values WITHOUT any separators
- For "136.000,50" return: 136000.50
- For "25.000" return: 25000
- NEVER include commas, periods, or spaces in your numeric responses
- Only return raw numbers that can be parsed directly (e.g., 136000.50, 25000)

Return the result ONLY as a valid JSON object with these exact keys. Use null for fields that cannot be determined.`;
  }

  // Create or fetch document record for S3 processing
  async createOrFetchDocument(params) {
    const { documentId, s3Key, bucketName, originalFilename, documentType, fileSize, vertical, organizationId } = params;
    
    const tableName = vertical === 'legal' ? 'legal_documents' : 'documents';
    
    // Try to fetch existing document first
    const { data: existing, error: fetchError } = await this.supabase
      .from(tableName)
      .select('*')
      .eq('id', documentId)
      .single();
      
    if (existing && !fetchError) {
      this.logger.info(`[${documentId}] Found existing document record`);
      return existing;
    }
    
    // Create new document record
    this.logger.info(`[${documentId}] Creating new document record for S3 file`);
    
    const documentData = {
      id: documentId,
      original_filename: originalFilename,
      file_path: s3Key,
      file_size: fileSize,
      document_type: documentType,
      processing_status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    // Add organization context if provided
    if (organizationId && organizationId !== 'default') {
      documentData.organization_id = organizationId;
    }
    
    const { data: created, error: createError } = await this.supabase
      .from(tableName)
      .insert(documentData)
      .select()
      .single();
      
    if (createError) {
      throw new Error(`Failed to create document record: ${createError.message}`);
    }
    
    this.logger.info(`[${documentId}] Created document record successfully`);
    return created;
  }

  // Download file from S3
  async downloadFileFromS3(bucketName, s3Key) {
    try {
      this.logger.info(`Downloading from S3: ${bucketName}/${s3Key}`);
      
      const params = {
        Bucket: bucketName,
        Key: s3Key
      };
      
      const data = await this.s3.getObject(params).promise();
      this.logger.info(`Successfully downloaded file: ${data.ContentLength} bytes`);
      
      return data.Body;
    } catch (error) {
      this.logger.error(`Failed to download from S3: ${bucketName}/${s3Key}`, error);
      throw new Error(`S3 download failed: ${error.message}`);
    }
  }

  // Real-time processing status updates (like accountant-app)
  async emitProcessingStatus(documentId, status, progress, extractedData, error) {
    try {
      const updateData = {
        processing_status: status,
        updated_at: new Date().toISOString(),
      };

      // For intermediate status updates, temporarily store preview data
      if (status === 'processing' && extractedData) {
        const processingInfo = {
          progress: progress || 0,
          preview: {
            vendor: extractedData.vendor,
            amount: extractedData.amount,
            currency: extractedData.currency,
            type: extractedData.type,
            confidence: extractedData.confidence
          },
          timestamp: new Date().toISOString()
        };
        
        // Store as JSON in description field for intermediate updates (like accountant-app)
        updateData.description = JSON.stringify(processingInfo);
      }

      // Update documents table (assuming accounting documents)
      await this.supabase
        .from('documents')
        .update(updateData)
        .eq('id', documentId);

      this.logger.info(`Status update emitted for document ${documentId}: ${status} (${progress || 0}%)`);
      if (extractedData) {
        this.logger.info(`Extraction preview: ${extractedData.vendor} • ${extractedData.amount} ${extractedData.currency}`);
      }
    } catch (emitError) {
      this.logger.error(`Failed to emit status for document ${documentId}:`, emitError);
    }
  }

  // Update document with final processing results
  async updateDocumentWithResults(documentId, processingResult, startTime) {
    const { extractedData, embeddings } = processingResult;
    
    if (!extractedData) {
      throw new Error('No extracted data to save');
    }

    // Generate vendor_normalized for search (like accountant-app)
    const vendor_normalized = extractedData.vendor 
      ? extractedData.vendor.toLowerCase().replace(/[^a-z0-9]/g, '') 
      : null;
    
    // Process tax type lookup
    let taxTypeId = null;
    if (extractedData.tax_type_name) {
      const { data: taxType } = await this.supabase
        .from('tax_types')
        .select('id')
        .ilike('tax_name_local', `%${extractedData.tax_type_name}%`)
        .single();
        
      if (taxType) {
        taxTypeId = taxType.id;
        this.logger.info(`Found tax type ID ${taxTypeId} for: ${extractedData.tax_type_name}`);
      }
    }

    // Update main document record
    const updateData = {
      vendor: extractedData.vendor,
      vendor_normalized: vendor_normalized,
      document_date: extractedData.date,
      document_type: extractedData.type,
      total_amount: extractedData.amount,
      currency: extractedData.currency,
      description: extractedData.description,
      discount: extractedData.discount,
      deposit_amount: extractedData.deposit_amount,
      ap_ar_status: extractedData.ap_ar_status,
      document_number: extractedData.document_number,
      tax_amount: extractedData.tax_amount,
      tax_type_id: taxTypeId,
      tax_type_name: extractedData.tax_type_name,
      service_charge_amount: extractedData.service_charge_amount,
      service_charge_type: extractedData.service_charge_type,
      due_date: extractedData.due_date,
      processing_status: 'complete',
      processing_time_ms: Date.now() - startTime,
      embedding_status: embeddings.length > 0 ? 'completed' : 'no_embeddings'
    };

    const { error: updateError } = await this.supabase
      .from('documents')
      .update(updateData)
      .eq('id', documentId);
      
    if (updateError) {
      throw new Error(`Failed to update document: ${updateError.message}`);
    }

    // Save line items if present
    if (Array.isArray(extractedData.line_items) && extractedData.line_items.length > 0) {
      await this.saveLineItems(documentId, extractedData.line_items, extractedData.ap_ar_status);
    } else {
      // Create default line item (like accountant-app)
      await this.createDefaultLineItem(documentId, extractedData);
    }

    // Save bank transactions if present
    if (Array.isArray(extractedData.bank_transactions) && extractedData.bank_transactions.length > 0) {
      await this.saveBankTransactions(documentId, extractedData.bank_transactions);
    }

    // Save embeddings if present
    if (embeddings.length > 0) {
      await this.saveDocumentChunks(documentId, embeddings);
    }

    this.logger.info(`[${documentId}] Successfully updated document with all extracted data`);
  }

  // Save line items with classification (simplified version from accountant-app)
  async saveLineItems(documentId, lineItems, apArStatus) {
    // Delete existing line items
    await this.supabase
      .from('document_line_items')
      .delete()
      .eq('document_id', documentId);
    
    const itemsToInsert = lineItems.map((item, index) => {
      // Simple classification logic (can be enhanced later)
      const isTaxLine = item.description && item.description.toLowerCase().includes('tax');
      const isDiscountLine = item.description && item.description.toLowerCase().includes('discount');
      
      return {
        document_id: documentId,
        description: item.description,
        quantity: item.quantity || 1,
        unit_price: item.unit_price,
        line_total_amount: item.line_total_amount,
        sort_order: index + 1,
        item_type: isTaxLine ? 'tax' : isDiscountLine ? 'discount' : 'product',
        is_tax_line: isTaxLine,
        is_discount_line: isDiscountLine
      };
    });
    
    const { error } = await this.supabase
      .from('document_line_items')
      .insert(itemsToInsert);
      
    if (error) {
      this.logger.error(`Error saving line items for document ${documentId}:`, error);
    } else {
      this.logger.info(`Successfully saved ${itemsToInsert.length} line items for document ${documentId}`);
    }
  }

  // Create default line item when no line items extracted
  async createDefaultLineItem(documentId, extractedData) {
    const defaultDescription = extractedData.description || 
                               (extractedData.vendor ? `Purchase from ${extractedData.vendor}` : 'General item');
    
    if (defaultDescription && extractedData.amount) {
      await this.supabase
        .from('document_line_items')
        .delete()
        .eq('document_id', documentId);

      const { error } = await this.supabase
        .from('document_line_items')
        .insert({
          document_id: documentId,
          description: defaultDescription,
          quantity: 1,
          unit_price: extractedData.amount,
          line_total_amount: extractedData.amount,
          sort_order: 1,
          item_type: 'product'
        });
        
      if (!error) {
        this.logger.info(`Successfully created default line item for document ${documentId}`);
      }
    }
  }

  // Save bank statement transactions
  async saveBankTransactions(documentId, bankTransactions) {
    // Delete existing transactions
    await this.supabase
      .from('bank_statement_transactions')
      .delete()
      .eq('document_id', documentId);
    
    const transactionsToInsert = bankTransactions.map((transaction, index) => ({
      document_id: documentId,
      transaction_date: transaction.transaction_date,
      description: transaction.description || '',
      reference_code: transaction.reference_code,
      debit_amount: transaction.debit_amount,
      credit_amount: transaction.credit_amount,
      running_balance: transaction.running_balance,
      transaction_type: transaction.transaction_type,
      sort_order: index + 1
    }));
    
    const { error } = await this.supabase
      .from('bank_statement_transactions')
      .insert(transactionsToInsert);
      
    if (error) {
      this.logger.error(`Error saving bank transactions for document ${documentId}:`, error);
    } else {
      this.logger.info(`Successfully saved ${transactionsToInsert.length} bank transactions for document ${documentId}`);
    }
  }

  // Save document chunks for embedding search
  async saveDocumentChunks(documentId, embeddings) {
    try {
      // Delete existing chunks
      await this.supabase
        .from('document_chunks')
        .delete()
        .eq('document_id', documentId);
      
      const chunksToInsert = embeddings.map((embedding, index) => ({
        document_id: documentId,
        content: embedding.text,
        embedding: embedding.embedding,
        chunk_index: index
      }));
      
      const { error } = await this.supabase
        .from('document_chunks')
        .insert(chunksToInsert);
        
      if (error) {
        this.logger.error(`Error saving document chunks for ${documentId}:`, error);
      } else {
        this.logger.info(`Successfully saved ${chunksToInsert.length} document chunks for ${documentId}`);
      }
    } catch (error) {
      this.logger.error(`Error in saveDocumentChunks for ${documentId}:`, error);
    }
  }

  // Handle processing errors
  async handleProcessingError(documentId, error, startTime) {
    try {
      await this.supabase
        .from('documents')
        .update({
          processing_status: 'failed',
          processing_time_ms: Date.now() - startTime,
          updated_at: new Date().toISOString()
        })
        .eq('id', documentId);
        
      await this.emitProcessingStatus(
        documentId, 
        'failed', 
        0, 
        undefined, 
        error.message
      );
      
      this.logger.error(`[${documentId}] Processing error handled:`, error);
    } catch (updateError) {
      this.logger.error(`[${documentId}] Failed to update error status:`, updateError);
    }
  }

  // Process existing document (compatibility with accountant-app cloud-run)
  async processExistingDocument(params) {
    const { documentId, vertical = 'accounting', organizationId = 'default' } = params;
    const startTime = Date.now();
    
    this.logger.info(`[${documentId}] Processing existing document from database`);

    try {
      // Get document from database
      const tableName = vertical === 'legal' ? 'legal_documents' : 'documents';
      const { data: document, error: fetchError } = await this.supabase
        .from(tableName)
        .select('*')
        .eq('id', documentId)
        .single();
        
      if (fetchError || !document) {
        throw new Error(`Document not found: ${documentId}`);
      }

      this.logger.info(`[${documentId}] Found document in database: ${document.original_filename}`);

      // Download file from S3 using the file_path
      let fileBuffer;
      let bucketName;
      
      if (document.file_path) {
        // Determine bucket from file path or document context
        bucketName = vertical === 'legal' ? 'legal-docs' : 'documents';
        
        // If file_path starts with bucket name, extract the key
        let s3Key = document.file_path;
        if (s3Key.startsWith(`${bucketName}/`)) {
          s3Key = s3Key.substring(`${bucketName}/`.length);
        }
        
        try {
          fileBuffer = await this.downloadFileFromS3(bucketName, s3Key);
        } catch (s3Error) {
          // Fallback: try different bucket configurations
          this.logger.warn(`[${documentId}] Primary S3 download failed, trying alternatives`);
          const altBuckets = ['documents', 'legal-docs', this.config.aws.s3BucketName].filter(Boolean);
          
          for (const altBucket of altBuckets) {
            try {
              fileBuffer = await this.downloadFileFromS3(altBucket, document.file_path);
              bucketName = altBucket;
              this.logger.info(`[${documentId}] Successfully downloaded from alternative bucket: ${altBucket}`);
              break;
            } catch (altError) {
              this.logger.warn(`[${documentId}] Alternative bucket ${altBucket} also failed`);
            }
          }
          
          if (!fileBuffer) {
            throw new Error(`Could not download file from any S3 bucket: ${document.file_path}`);
          }
        }
      } else {
        throw new Error('Document has no file_path for S3 download');
      }

      await this.emitProcessingStatus(documentId, 'processing', 25);

      // Process the file content using enhanced logic
      const processingResult = await this.processFileContentEnhanced(
        documentId, 
        fileBuffer, 
        document, 
        startTime
      );
      
      await this.emitProcessingStatus(documentId, 'processing', 90);

      // Update document with results
      await this.updateDocumentWithResults(documentId, processingResult, startTime);
      await this.emitProcessingStatus(documentId, 'complete', 100);

      const processingTime = Date.now() - startTime;
      this.logger.info(`[${documentId}] Existing document processing completed successfully`, {
        documentId,
        processingTime,
        status: 'complete',
        extractedData: !!processingResult.extractedData,
        embeddings: processingResult.embeddingsCount || 0
      });

      return {
        success: true,
        documentId,
        processingTime,
        status: 'complete',
        analysis: processingResult.extractedData?.description || 'Processing completed',
        structuredData: processingResult.extractedData,
        embeddings: processingResult.embeddingsCount || 0
      };

    } catch (error) {
      this.logger.error(`[${documentId}] Existing document processing failed:`, error);
      await this.handleProcessingError(documentId, error, startTime);
      throw error;
    }
  }

  async downloadDocumentFromS3(s3Key, documentId, originalFilename, documentType) {
    try {
      this.logger.info(`[${documentId}] Downloading from S3: ${s3Key}`);
      
      const params = {
        Bucket: this.config.aws.s3BucketName,
        Key: s3Key
      };
      
      const result = await this.s3.getObject(params).promise();
      const fileBuffer = result.Body;
      
      // Create document metadata object (similar to Supabase structure)
      const document = {
        id: documentId,
        original_filename: originalFilename,
        document_type: documentType,
        file_path: s3Key,
        file_size: result.ContentLength,
        created_at: new Date().toISOString(),
        s3_etag: result.ETag
      };
      
      this.logger.info(`[${documentId}] Downloaded ${result.ContentLength} bytes from S3`);
      
      return { document, fileBuffer };
    } catch (error) {
      this.logger.error(`[${documentId}] S3 download failed:`, error);
      throw new Error(`Failed to download file from S3: ${s3Key} - ${error.message}`);
    }
  }

  // Keep the original method for backward compatibility (if needed)
  async downloadDocument(documentId, vertical) {
    const tableName = vertical === 'legal' ? 'legal_documents' : 'documents';
    
    // Get document metadata
    const { data: document, error: docError } = await this.supabase
      .from(tableName)
      .select('*')
      .eq('id', documentId)
      .single();
      
    if (docError || !document) {
      throw new Error(`Document not found: ${documentId}`);
    }
    
    // Download file from storage
    const bucketName = vertical === 'legal' ? 'legal-docs' : 'documents';
    const { data: fileData, error: downloadError } = await this.supabase.storage
      .from(bucketName)
      .download(document.file_path);
      
    if (downloadError || !fileData) {
      throw new Error(`Failed to download file: ${document.file_path}`);
    }
    
    const fileBuffer = Buffer.from(await fileData.arrayBuffer());
    
    return { document, fileBuffer };
  }

  getDefaultStructuredData() {
    return {
      vendor_name: null,
      document_type: 'other',
      document_date: null,
      due_date: null,
      total_amount: null,
      tax_amount: null,
      currency: 'IDR',
      line_items: [],
      bank_transactions: []
    };
  }

  // Health check methods
  async checkHealth() {
    try {
      const { data, error } = await this.supabase
        .from('documents')
        .select('count')
        .limit(1);
      return error ? 'unhealthy' : 'healthy';
    } catch (error) {
      return 'unhealthy';
    }
  }


  async checkAIHealth() {
    try {
      const result = await this.extractionModel.generateContent([
        { text: 'Test health check - respond with "OK"' }
      ]);
      return result.response.text().includes('OK') ? 'healthy' : 'unhealthy';
    } catch (error) {
      return 'unhealthy';
    }
  }

  async cleanup() {
    // Cleanup connections if needed in the future
  }
}

module.exports = DocumentProcessor;
