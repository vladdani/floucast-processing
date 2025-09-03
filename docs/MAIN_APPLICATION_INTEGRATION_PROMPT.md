# 🔗 Main Application Integration Prompt

**Task**: Integrate the main application with the floucast-processing document processing service  
**Date**: January 3, 2025  
**Complexity**: Medium (2-3 days implementation)

---

## 📋 Integration Requirements

You need to update the main application to integrate with the existing floucast-processing service for automatic document processing. The integration involves:

1. **File Upload Integration**: Upload documents to S3 to trigger processing
2. **Real-time Status Tracking**: Monitor processing progress via Supabase
3. **Results Retrieval**: Access processed document data and extracted information
4. **Error Handling**: Handle processing failures and retry mechanisms

---

## 🎯 Implementation Tasks

### **Phase 1: S3 Upload Integration** (Priority: High)

#### **1.1 Configure AWS S3 Client**
```javascript
// Add to your environment configuration
const AWS_CONFIG = {
  region: 'ap-southeast-3',
  s3BucketName: 'floucast-documents',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
};

// Install required packages
npm install @aws-sdk/client-s3 uuid
```

#### **1.2 Create Document Upload Service**
Create a new service file: `src/services/documentProcessing.js`

```javascript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../lib/supabase';

class DocumentProcessingService {
  constructor() {
    this.s3Client = new S3Client({
      region: 'ap-southeast-3',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    });
    this.bucketName = 'floucast-documents';
  }

  /**
   * Upload document for processing
   * @param {File} file - File object from form input
   * @param {string} organizationId - Organization UUID
   * @param {string} vertical - 'accounting' or 'legal'
   * @param {string} userId - User UUID
   * @returns {Promise<{documentId: string, s3Key: string}>}
   */
  async uploadDocument(file, organizationId, vertical = 'accounting', userId) {
    const documentId = uuidv4();
    const fileExtension = file.name.split('.').pop().toLowerCase();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${documentId}_${timestamp}.${fileExtension}`;
    
    // Determine S3 path based on document type
    const folderName = vertical === 'legal' ? 'legal-docs' : 'documents';
    const s3Key = `${folderName}/${organizationId}/${filename}`;

    try {
      // Upload to S3 with metadata
      const uploadCommand = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: file,
        ContentType: file.type,
        Metadata: {
          'original-filename': file.name,
          'document-id': documentId,
          'organization-id': organizationId,
          'vertical': vertical,
          'uploaded-by': userId
        }
      });

      await this.s3Client.send(uploadCommand);

      // Create document record in Supabase
      const documentRecord = await this.createDocumentRecord({
        documentId,
        originalFilename: file.name,
        s3Key,
        mimeType: file.type,
        fileSize: file.size,
        organizationId,
        vertical,
        userId
      });

      return {
        documentId,
        s3Key,
        document: documentRecord
      };

    } catch (error) {
      console.error('Failed to upload document:', error);
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  /**
   * Create initial document record
   */
  async createDocumentRecord(documentData) {
    const tableName = documentData.vertical === 'legal' ? 'legal_documents' : 'documents';
    
    const record = {
      id: documentData.documentId,
      original_filename: documentData.originalFilename,
      file_path: documentData.s3Key,
      document_type: documentData.mimeType,
      file_size: documentData.fileSize,
      processing_status: 'pending',
      organization_id: documentData.organizationId,
      uploaded_by: documentData.userId,
      uploaded_at: new Date().toISOString()
    };

    // Add legal-specific fields
    if (documentData.vertical === 'legal') {
      record.is_legal = true;
    }

    const { data, error } = await supabase
      .from(tableName)
      .insert(record)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create document record: ${error.message}`);
    }

    return data;
  }
}

export default new DocumentProcessingService();
```

#### **1.3 Create Upload Component/Hook**
Create `src/hooks/useDocumentUpload.js`:

```javascript
import { useState } from 'react';
import documentProcessingService from '../services/documentProcessing';

export const useDocumentUpload = () => {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState(null);

  const uploadDocument = async (file, organizationId, vertical = 'accounting', userId) => {
    setUploading(true);
    setUploadProgress(0);
    setError(null);

    try {
      // Validate file
      if (!file) throw new Error('No file selected');
      if (file.size > 50 * 1024 * 1024) throw new Error('File too large (max 50MB)');
      
      const supportedTypes = [
        'application/pdf',
        'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel'
      ];
      
      if (!supportedTypes.includes(file.type)) {
        throw new Error('Unsupported file type');
      }

      setUploadProgress(25);

      const result = await documentProcessingService.uploadDocument(
        file, 
        organizationId, 
        vertical, 
        userId
      );

      setUploadProgress(100);

      return result;

    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setUploading(false);
    }
  };

  return {
    uploadDocument,
    uploading,
    uploadProgress,
    error,
    resetError: () => setError(null)
  };
};
```

### **Phase 2: Real-time Status Tracking** (Priority: High)

#### **2.1 Create Processing Status Hook**
Create `src/hooks/useDocumentProcessing.js`:

```javascript
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export const useDocumentProcessing = (documentId, vertical = 'accounting') => {
  const [status, setStatus] = useState('pending');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [processingTime, setProcessingTime] = useState(null);
  const [isComplete, setIsComplete] = useState(false);
  const [document, setDocument] = useState(null);

  // Progress mapping for different statuses
  const getProgressFromStatus = (status) => {
    const progressMap = {
      'pending': 0,
      'processing': 50, // Will be updated with actual progress
      'complete': 100,
      'failed': 0
    };
    return progressMap[status] || 0;
  };

  // Fetch current document data
  const fetchDocument = useCallback(async () => {
    if (!documentId) return;

    try {
      const tableName = vertical === 'legal' ? 'legal_documents' : 'documents';
      
      const { data, error } = await supabase
        .from(tableName)
        .select(`
          *,
          ${vertical === 'accounting' ? `
            document_line_items (*),
            bank_statement_transactions (*)
          ` : ''}
        `)
        .eq('id', documentId)
        .single();

      if (error) throw error;

      setDocument(data);
      setStatus(data.processing_status);
      setProgress(getProgressFromStatus(data.processing_status));
      setIsComplete(data.processing_status === 'complete');
      setProcessingTime(data.processing_time_ms);
      
      if (data.processing_status === 'failed') {
        setError(data.ai_extraction_error || 'Processing failed');
      }

    } catch (err) {
      setError(err.message);
    }
  }, [documentId, vertical]);

  // Subscribe to real-time updates
  useEffect(() => {
    if (!documentId) return;

    // Initial fetch
    fetchDocument();

    const tableName = vertical === 'legal' ? 'legal_documents' : 'documents';
    
    // Subscribe to changes
    const subscription = supabase
      .channel(`document-${documentId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: tableName,
        filter: `id=eq.${documentId}`
      }, (payload) => {
        const { 
          processing_status, 
          processing_time_ms, 
          ai_extraction_error 
        } = payload.new;

        setStatus(processing_status);
        setProgress(getProgressFromStatus(processing_status));
        setProcessingTime(processing_time_ms);
        setIsComplete(processing_status === 'complete');
        
        if (processing_status === 'failed') {
          setError(ai_extraction_error || 'Processing failed');
        } else if (processing_status === 'complete') {
          setError(null);
          // Refetch complete document with relations
          fetchDocument();
        }
      })
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [documentId, vertical, fetchDocument]);

  // Retry processing
  const retryProcessing = async () => {
    if (!documentId) return;

    try {
      const tableName = vertical === 'legal' ? 'legal_documents' : 'documents';
      
      const { error } = await supabase
        .from(tableName)
        .update({
          processing_status: 'pending',
          ai_extraction_error: null,
          updated_at: new Date().toISOString()
        })
        .eq('id', documentId);

      if (error) throw error;

      setError(null);
      setStatus('pending');
      setProgress(0);
      setIsComplete(false);

    } catch (err) {
      setError(`Retry failed: ${err.message}`);
    }
  };

  return {
    status,
    progress,
    error,
    processingTime,
    isComplete,
    document,
    retryProcessing,
    refreshDocument: fetchDocument
  };
};
```

#### **2.2 Create Processing Status Component**
Create `src/components/ProcessingStatus.jsx`:

```javascript
import React from 'react';
import { useDocumentProcessing } from '../hooks/useDocumentProcessing';

export const ProcessingStatus = ({ documentId, vertical = 'accounting', onComplete }) => {
  const {
    status,
    progress,
    error,
    processingTime,
    isComplete,
    document,
    retryProcessing
  } = useDocumentProcessing(documentId, vertical);

  React.useEffect(() => {
    if (isComplete && onComplete) {
      onComplete(document);
    }
  }, [isComplete, document, onComplete]);

  const getStatusMessage = () => {
    switch (status) {
      case 'pending':
        return 'Queued for processing...';
      case 'processing':
        return 'Processing document with AI...';
      case 'complete':
        return `Processing completed in ${processingTime ? Math.round(processingTime / 1000) : '?'}s`;
      case 'failed':
        return 'Processing failed';
      default:
        return 'Unknown status';
    }
  };

  const getStatusColor = () => {
    switch (status) {
      case 'pending': return 'text-yellow-600 bg-yellow-50';
      case 'processing': return 'text-blue-600 bg-blue-50';
      case 'complete': return 'text-green-600 bg-green-50';
      case 'failed': return 'text-red-600 bg-red-50';
      default: return 'text-gray-600 bg-gray-50';
    }
  };

  return (
    <div className="space-y-3">
      {/* Status Badge */}
      <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${getStatusColor()}`}>
        {status === 'processing' && (
          <svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
          </svg>
        )}
        {getStatusMessage()}
      </div>

      {/* Progress Bar */}
      {status === 'processing' && (
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div 
            className="bg-blue-600 h-2 rounded-full transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="flex items-center justify-between p-3 bg-red-50 border border-red-200 rounded-lg">
          <div className="text-red-700 text-sm">{error}</div>
          <button
            onClick={retryProcessing}
            className="px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      )}

      {/* Success Summary */}
      {isComplete && document && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
          <h4 className="font-medium text-green-800 mb-2">Processing Complete</h4>
          <div className="text-sm text-green-700 space-y-1">
            {vertical === 'accounting' && (
              <>
                {document.vendor && <div>Vendor: {document.vendor}</div>}
                {document.total_amount && <div>Amount: {document.currency || 'IDR'} {document.total_amount.toLocaleString()}</div>}
                {document.document_date && <div>Date: {new Date(document.document_date).toLocaleDateString()}</div>}
                {document.document_line_items?.length > 0 && <div>Line items: {document.document_line_items.length}</div>}
              </>
            )}
            {vertical === 'legal' && (
              <>
                {document.contract_type && <div>Type: {document.contract_type}</div>}
                {document.contract_value && <div>Value: IDR {document.contract_value.toLocaleString()}</div>}
                {document.contract_date && <div>Date: {new Date(document.contract_date).toLocaleDateString()}</div>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
```

### **Phase 3: Document Upload UI** (Priority: High)

#### **3.1 Create Document Upload Component**
Create `src/components/DocumentUpload.jsx`:

```javascript
import React, { useState, useRef } from 'react';
import { useDocumentUpload } from '../hooks/useDocumentUpload';
import { ProcessingStatus } from './ProcessingStatus';

export const DocumentUpload = ({ 
  organizationId, 
  userId, 
  vertical = 'accounting',
  onUploadComplete 
}) => {
  const fileInputRef = useRef();
  const [uploadedDocuments, setUploadedDocuments] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  
  const { uploadDocument, uploading, uploadProgress, error, resetError } = useDocumentUpload();

  const handleFileSelect = (files) => {
    Array.from(files).forEach(handleSingleFile);
  };

  const handleSingleFile = async (file) => {
    try {
      resetError();
      
      const result = await uploadDocument(file, organizationId, vertical, userId);
      
      setUploadedDocuments(prev => [...prev, {
        ...result,
        file: { name: file.name, size: file.size, type: file.type }
      }]);

      if (onUploadComplete) {
        onUploadComplete(result);
      }

    } catch (err) {
      console.error('Upload failed:', err);
      // Error is already handled by the hook
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files) {
      handleFileSelect(e.dataTransfer.files);
    }
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Upload Area */}
      <div
        className={`border-2 border-dashed rounded-lg p-8 text-center ${
          dragActive 
            ? 'border-blue-400 bg-blue-50' 
            : 'border-gray-300 hover:border-gray-400'
        } ${uploading ? 'opacity-50 pointer-events-none' : ''}`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.xls"
          onChange={(e) => handleFileSelect(e.target.files)}
          className="hidden"
        />
        
        <div className="space-y-4">
          <div className="mx-auto w-12 h-12 text-gray-400">
            <svg fill="none" stroke="currentColor" viewBox="0 0 48 48">
              <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          
          <div>
            <p className="text-lg font-medium text-gray-900">
              Drop files here or click to upload
            </p>
            <p className="text-sm text-gray-500 mt-1">
              Supports PDF, Images, and Spreadsheets (max 50MB)
            </p>
          </div>
          
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : 'Choose Files'}
          </button>
          
          {uploading && (
            <div className="mt-4">
              <div className="bg-blue-200 rounded-full h-2">
                <div 
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
              <p className="text-sm text-gray-500 mt-1">
                Uploading... {uploadProgress}%
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="text-red-800 font-medium">Upload Error</div>
          <div className="text-red-700 text-sm mt-1">{error}</div>
        </div>
      )}

      {/* Uploaded Documents */}
      {uploadedDocuments.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-lg font-medium text-gray-900">Processing Status</h3>
          {uploadedDocuments.map((doc) => (
            <div key={doc.documentId} className="border rounded-lg p-4">
              <div className="flex justify-between items-start mb-3">
                <div>
                  <h4 className="font-medium text-gray-900">{doc.file.name}</h4>
                  <p className="text-sm text-gray-500">
                    {(doc.file.size / 1024 / 1024).toFixed(1)} MB • {doc.file.type}
                  </p>
                </div>
                <span className="text-xs text-gray-400 font-mono">
                  {doc.documentId.slice(0, 8)}...
                </span>
              </div>
              
              <ProcessingStatus
                documentId={doc.documentId}
                vertical={vertical}
                onComplete={(document) => {
                  console.log('Document processing complete:', document);
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
```

### **Phase 4: Results Display** (Priority: Medium)

#### **4.1 Create Document Results Component**
Create `src/components/DocumentResults.jsx`:

```javascript
import React from 'react';

export const DocumentResults = ({ document, vertical = 'accounting' }) => {
  if (!document || document.processing_status !== 'complete') {
    return null;
  }

  const formatCurrency = (amount, currency = 'IDR') => {
    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2
    }).format(amount);
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    return new Date(dateString).toLocaleDateString('id-ID');
  };

  return (
    <div className="bg-white shadow-sm border rounded-lg overflow-hidden">
      <div className="px-6 py-4 bg-gray-50 border-b">
        <h3 className="text-lg font-medium text-gray-900">
          Extracted Information
        </h3>
      </div>

      <div className="p-6 space-y-6">
        {vertical === 'accounting' && (
          <>
            {/* Basic Information */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium text-gray-500">Vendor</label>
                <p className="mt-1 text-gray-900">{document.vendor || 'N/A'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Document Type</label>
                <p className="mt-1 text-gray-900">{document.document_type || 'N/A'}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Date</label>
                <p className="mt-1 text-gray-900">{formatDate(document.document_date)}</p>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-500">Due Date</label>
                <p className="mt-1 text-gray-900">{formatDate(document.due_date)}</p>
              </div>
            </div>

            {/* Financial Information */}
            {document.total_amount && (
              <div className="bg-green-50 p-4 rounded-lg">
                <label className="text-sm font-medium text-green-800">Total Amount</label>
                <p className="text-2xl font-bold text-green-900">
                  {formatCurrency(document.total_amount, document.currency)}
                </p>
              </div>
            )}

            {/* Line Items */}
            {document.document_line_items?.length > 0 && (
              <div>
                <h4 className="text-md font-medium text-gray-900 mb-3">Line Items</h4>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                          Description
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                          Qty
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                          Unit Price
                        </th>
                        <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {document.document_line_items.map((item, index) => (
                        <tr key={index}>
                          <td className="px-4 py-2 text-sm text-gray-900">
                            {item.description}
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-900">
                            {item.quantity || 1}
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-900">
                            {item.unit_price ? formatCurrency(item.unit_price) : 'N/A'}
                          </td>
                          <td className="px-4 py-2 text-sm text-gray-900">
                            {item.line_total_amount ? formatCurrency(item.line_total_amount) : 'N/A'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Bank Transactions */}
            {document.bank_statement_transactions?.length > 0 && (
              <div>
                <h4 className="text-md font-medium text-gray-900 mb-3">Bank Transactions</h4>
                <div className="space-y-2">
                  {document.bank_statement_transactions.map((transaction, index) => (
                    <div key={index} className="flex justify-between items-center p-3 bg-gray-50 rounded">
                      <div>
                        <p className="text-sm font-medium text-gray-900">
                          {transaction.description}
                        </p>
                        <p className="text-xs text-gray-500">
                          {formatDate(transaction.transaction_date)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={`text-sm font-medium ${
                          transaction.transaction_type === 'credit' 
                            ? 'text-green-600' 
                            : 'text-red-600'
                        }`}>
                          {transaction.transaction_type === 'credit' ? '+' : '-'}
                          {formatCurrency(Math.abs(transaction.amount))}
                        </p>
                        <p className="text-xs text-gray-500">
                          Balance: {formatCurrency(transaction.running_balance)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {vertical === 'legal' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium text-gray-500">Contract Type</label>
              <p className="mt-1 text-gray-900">{document.contract_type || 'N/A'}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Contract Date</label>
              <p className="mt-1 text-gray-900">{formatDate(document.contract_date)}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Expiry Date</label>
              <p className="mt-1 text-gray-900">{formatDate(document.expiry_date)}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-gray-500">Contract Value</label>
              <p className="mt-1 text-gray-900">
                {document.contract_value ? formatCurrency(document.contract_value) : 'N/A'}
              </p>
            </div>
            {document.parties_involved?.length > 0 && (
              <div className="col-span-2">
                <label className="text-sm font-medium text-gray-500">Parties Involved</label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {document.parties_involved.map((party, index) => (
                    <span key={index} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      {party}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Raw Extracted Data (for debugging) */}
        {process.env.NODE_ENV === 'development' && document.extracted_data && (
          <details className="text-sm">
            <summary className="cursor-pointer text-gray-500 font-medium">
              Raw Extracted Data (Debug)
            </summary>
            <pre className="mt-2 p-3 bg-gray-100 rounded overflow-x-auto text-xs">
              {JSON.stringify(document.extracted_data, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
};
```

### **Phase 5: Environment Configuration** (Priority: High)

#### **5.1 Update Environment Variables**
Add to your `.env` file:

```env
# AWS Configuration for S3 uploads
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
AWS_REGION=ap-southeast-3
S3_BUCKET_NAME=floucast-documents

# Supabase (should already exist)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Optional: Processing service URL for manual triggering
PROCESSING_SERVICE_URL=http://internal-load-balancer:8080
```

#### **5.2 Create Environment Type Definitions**
Add to your types file or create `src/types/environment.d.ts`:

```typescript
declare namespace NodeJS {
  interface ProcessEnv {
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    AWS_REGION: string;
    S3_BUCKET_NAME: string;
    NEXT_PUBLIC_SUPABASE_URL: string;
    NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    PROCESSING_SERVICE_URL?: string;
  }
}
```

### **Phase 6: Integration Testing** (Priority: Medium)

#### **6.1 Create Test Page**
Create a test page `pages/test-processing.js` (or in your routing structure):

```javascript
import React, { useState } from 'react';
import { DocumentUpload } from '../components/DocumentUpload';
import { DocumentResults } from '../components/DocumentResults';

export default function TestProcessing() {
  const [processedDocuments, setProcessedDocuments] = useState([]);
  
  // Mock data - replace with actual user/organization data
  const userId = 'user-uuid-here';
  const organizationId = 'org-uuid-here';

  const handleUploadComplete = (result) => {
    console.log('Document uploaded:', result);
  };

  const handleProcessingComplete = (document) => {
    console.log('Document processed:', document);
    setProcessedDocuments(prev => [...prev, document]);
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          Document Processing Test
        </h1>
        <p className="text-gray-600 mt-1">
          Upload documents to test the processing pipeline
        </p>
      </div>

      {/* Upload Section */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          Upload Documents
        </h2>
        <DocumentUpload
          organizationId={organizationId}
          userId={userId}
          vertical="accounting"
          onUploadComplete={handleUploadComplete}
        />
      </section>

      {/* Results Section */}
      {processedDocuments.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Processed Documents
          </h2>
          <div className="space-y-6">
            {processedDocuments.map((doc) => (
              <DocumentResults
                key={doc.id}
                document={doc}
                vertical="accounting"
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
```

---

## 📋 Implementation Checklist

### **Setup Tasks**
- [ ] Install required npm packages: `@aws-sdk/client-s3`, `uuid`
- [ ] Add AWS credentials to environment variables
- [ ] Verify Supabase configuration matches processing service
- [ ] Test S3 bucket access and permissions

### **Development Tasks**
- [ ] Implement DocumentProcessingService class
- [ ] Create useDocumentUpload hook
- [ ] Create useDocumentProcessing hook  
- [ ] Build DocumentUpload component
- [ ] Build ProcessingStatus component
- [ ] Build DocumentResults component
- [ ] Create test page for integration testing

### **Integration Tasks**
- [ ] Test file upload to S3
- [ ] Verify SQS message triggering
- [ ] Test real-time status updates
- [ ] Test complete processing flow
- [ ] Handle error scenarios and retries
- [ ] Test different document types (PDF, images, Excel)

### **UI/UX Tasks**
- [ ] Style components to match your application design
- [ ] Add loading states and progress indicators
- [ ] Implement drag-and-drop file upload
- [ ] Add file validation and error messages
- [ ] Create responsive layouts for mobile
- [ ] Add accessibility features

---

## 🔧 Common Issues & Solutions

### **Issue 1: S3 Upload Permissions**
```javascript
// If S3 upload fails, check IAM permissions
const testS3Connection = async () => {
  try {
    await s3Client.send(new ListBucketsCommand({}));
    console.log('S3 connection successful');
  } catch (error) {
    console.error('S3 connection failed:', error.message);
  }
};
```

### **Issue 2: Supabase Real-time Not Working**
```javascript
// Ensure RLS policies allow real-time subscriptions
// Check if user has access to the documents table
const testSupabaseConnection = async () => {
  const { data, error } = await supabase.from('documents').select('count').limit(1);
  if (error) console.error('Supabase access denied:', error);
  else console.log('Supabase connection successful');
};
```

### **Issue 3: File Processing Stuck**
```javascript
// Add timeout to detect stuck processing
const PROCESSING_TIMEOUT = 30 * 60 * 1000; // 30 minutes

const isDocumentStuck = (document) => {
  if (document.processing_status === 'processing') {
    const timeSinceUpdate = Date.now() - new Date(document.updated_at).getTime();
    return timeSinceUpdate > PROCESSING_TIMEOUT;
  }
  return false;
};
```

---

## 🎯 Expected Results

After implementing this integration:

1. **File Upload**: Users can upload documents via drag-and-drop or file picker
2. **Real-time Processing**: Status updates appear automatically as processing progresses
3. **Rich Results**: Extracted data displays with structured information (line items, amounts, etc.)
4. **Error Handling**: Failed processing shows clear error messages with retry options
5. **Multiple Formats**: Support for PDFs, images, and spreadsheets
6. **Responsive UI**: Works on desktop and mobile devices

### **Success Criteria**
- [ ] Documents upload successfully to S3
- [ ] Processing starts automatically via SQS
- [ ] Status updates appear in real-time
- [ ] Extracted data displays correctly
- [ ] Error states handle gracefully
- [ ] Performance is acceptable (<5s for small files)

---

## 🚀 Next Steps

1. **Start with Phase 1** - implement S3 upload functionality
2. **Test incrementally** - validate each phase before moving to the next
3. **Monitor performance** - track processing times and success rates
4. **Gather user feedback** - refine UI based on actual usage
5. **Scale gradually** - start with limited users before full rollout

This integration will provide your users with seamless document processing capabilities powered by AI, with full transparency into the processing status and rich extracted data results.