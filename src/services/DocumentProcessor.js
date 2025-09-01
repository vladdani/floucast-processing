const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const sharp = require('sharp');
const heicConvert = require('heic-convert');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const { getConfig } = require('../utils/environment');

class DocumentProcessor {
  constructor({ logger }) {
    this.logger = logger;
    this.config = getConfig();
    this.supabase = null;
    this.genAI = null;
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
    
    // Initialize Gemini AI
    this.genAI = new GoogleGenerativeAI(this.config.ai.geminiApiKey);
    this.extractionModel = this.genAI.getGenerativeModel({ 
      model: this.config.ai.model 
    });
    this.embeddingModel = this.genAI.getGenerativeModel({ 
      model: this.config.ai.embeddingModel 
    });
    
    
    this.logger.info('✅ DocumentProcessor initialized successfully');
  }

  async processDocument(jobData) {
    const { documentId, vertical, organizationId } = jobData;
    const startTime = Date.now();
    
    this.logger.info(`[${documentId}] Starting document processing`, {
      documentId,
      vertical,
      organizationId
    });

    try {
      // Update status to processing
      await this.updateStatus(documentId, vertical, 'processing', 10);

      // Step 1: Download file from Supabase Storage
      const { document, fileBuffer } = await this.downloadDocument(documentId, vertical);
      await this.updateStatus(documentId, vertical, 'processing', 20);

      // Step 2: Process file content using EXACT same logic as Vercel
      const processingResult = await this.processFileContent(
        documentId, 
        fileBuffer, 
        document, 
        vertical
      );
      await this.updateStatus(documentId, vertical, 'processing', 80);

      // Step 3: Generate embeddings for search
      if (processingResult.extractedText) {
        await this.generateEmbeddings(documentId, processingResult.extractedText, vertical);
      }
      await this.updateStatus(documentId, vertical, 'processing', 90);

      // Step 4: Save results to database
      await this.saveProcessingResults(documentId, vertical, processingResult);
      await this.updateStatus(documentId, vertical, 'complete', 100);

      const processingTime = Date.now() - startTime;
      this.logger.info(`[${documentId}] Processing completed successfully`, {
        documentId,
        processingTime,
        status: 'complete'
      });

      return {
        success: true,
        documentId,
        processingTime,
        result: processingResult
      };

    } catch (error) {
      this.logger.error(`[${documentId}] Processing failed:`, error);
      await this.updateStatus(documentId, vertical, 'failed', 0, error.message);
      throw error;
    }
  }

  async processFileContent(documentId, fileBuffer, document, vertical) {
    const isXlsxFile = document.original_filename.toLowerCase().endsWith('.xlsx') ||
                      document.original_filename.toLowerCase().endsWith('.xls');
    
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