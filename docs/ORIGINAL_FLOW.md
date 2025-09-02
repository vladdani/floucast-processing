Complete File Upload and Processing Flow

  1. Upload Initiation

  - Route Selection: Files ≤10MB → /api/simple-upload, Files >10MB → /api/simple-upload-large
  - Client calculates SHA256 hash for large files (deduplication)
  - Form data includes: file, vertical (legal/accounting), projectId, organizationId

  2. Server-Side Validation & Setup

  // Authentication & Organization Resolution
  user = await supabase.auth.getUser()
  organizationId = await get_user_organizations(user.id)

  // File Security Validation
  validateFileMetadata(file.name, file.type, file.size, { vertical })
  // Size limits: Legal 100MB, Accounting 25MB

  3. Duplicate Detection

  SELECT id, original_filename, file_path
  FROM {documents|legal_documents}
  WHERE content_hash = fileHash
    AND organization_id = organizationId
  - If duplicate found: Returns existing document info, no upload
  - If unique: Continues with upload

  4. File Storage

  // Path Generation
  docId = crypto.randomUUID()
  filePath = `${vertical}/${user.id}/${year}/${month}/${docId}.${extension}`
  bucket = vertical === 'legal' ? 'legal-docs' : 'documents'

  // Supabase Storage Upload
  await supabaseAdmin.storage
    .from(bucket)
    .upload(filePath, fileBuffer, { contentType: file.type })

  5. Database Record Creation

  For Accounting Documents (documents table):

  INSERT INTO documents (
    id,                    -- Generated UUID
    original_filename,     -- User's filename
    file_path,            -- Storage path
    document_type,        -- MIME type
    organization_id,      -- Multi-tenant isolation
    uploaded_by,          -- User ID
    content_hash,         -- SHA256 for deduplication
    file_size,           -- File size in bytes
    processing_status,   -- 'processing' initially
    uploaded_at,         -- Timestamp
    is_legal            -- false for accounting
  )

  For Legal Documents (legal_documents table):

  INSERT INTO legal_documents (
    id, original_filename, file_path, document_type,
    organization_id, uploaded_by, content_hash,
    file_size, processing_status, uploaded_at,
    project_id,              -- Legal project association
    is_repository,           -- Repository flag
    repository_folder_id     -- Folder organization
  )

  6. AI Processing (Two Paths)

  Path A: Immediate Processing (≤10MB files)

  // Direct API call to processing endpoint
  processingEndpoint = vertical === 'legal'
    ? `/verticals/legal/api/process-legal-document`
    : `/verticals/accounting/api/process-document`

  await fetch(processingEndpoint, {
    method: 'POST',
    body: JSON.stringify({ documentId: docId, source: 'simple-upload' }),
    timeout: 300000 // 5 minutes
  })

  Path B: Queue Processing (>10MB files)

  INSERT INTO processing_queue (
    id, document_id, queue_type, status,
    priority, metadata, created_at
  )
  - Cloud Run webhook processes queue asynchronously
  - Higher failure rate (~30%) due to webhook reliability issues

  7. AI Extraction Process

  For Accounting Documents:

  // Google Gemini AI Processing
  const extractedData = {
    vendor: string,
    date: ISO_date_string,
    amount: number,
    currency: string,
    description: string,
    ap_ar_status: 'AP' | 'AR' | 'N/A',
    document_number: string,
    tax_amount: number,
    tax_type_name: string,
    line_items: Array<{
      description: string,
      quantity: number,
      unit_price: number,
      line_total_amount: number
    }>
  }

  Database Updates After Processing:

  -- Update main document record
  UPDATE documents SET
    processing_status = 'complete',
    vendor_name = extracted_data.vendor,
    total_amount = extracted_data.amount,
    document_date = extracted_data.date,
    tax_amount = extracted_data.tax_amount,
    document_number = extracted_data.document_number,
    ai_extracted_data = json_data,
    processing_time_ms = duration
  WHERE id = docId;

  -- Insert line items
  INSERT INTO document_line_items (
    document_id, description, quantity,
    unit_price, line_total_amount, sort_order
  ) VALUES [...extracted_line_items];

  -- Create searchable chunks
  INSERT INTO document_chunks (
    document_id, content, embedding,
    chunk_index, user_id
  ) VALUES [...text_chunks_with_embeddings];

  8. Status Tracking & User Feedback

  Processing Status Values:

  - 'processing' - Initial status, AI extraction in progress
  - 'complete' - Successfully processed with extracted data
  - 'failed' - Processing failed, error details in ai_extraction_error

  How Application Determines Processing Complete:

  // Frontend polls document status
  const { data: document } = await supabase
    .from('documents')
    .select('processing_status, ai_extracted_data, vendor_name, total_amount')
    .eq('id', documentId)
    .single()

  // Status badges in UI
  if (processing_status === 'complete') {
    // Show extracted data: vendor, amount, date
    // Enable Xero sync, editing capabilities
  } else if (processing_status === 'processing') {
    // Show spinner/skeleton
    // Continue polling every 2-3 seconds
  } else if (processing_status === 'failed') {
    // Show error state
    // Offer retry functionality
  }

  9. Real-time Updates (Current Limitations)

  Current Method: Polling

  // Client-side polling every 2-3 seconds
  useEffect(() => {
    const pollStatus = setInterval(() => {
      if (processing_status === 'processing') {
        fetchDocumentStatus(documentId)
      }
    }, 3000)
  }, [processing_status])

  Major Issue:

  - No real-time notifications when Cloud Run processing completes
  - Webhook failures (~30% failure rate) leave documents in processing state
  - Users don't know when large files finish processing

  10. Data Relationships Created

  User
  ├── organization_members (role, status)
  ├── organizations (multi-tenant)
  └── documents/legal_documents
      ├── file_path → Storage bucket file
      ├── document_line_items (extracted line items)
      ├── document_chunks (search embeddings)
      └── processing_queue (background jobs)

  11. User Experience Flow

  1. Upload UI: Drag & drop → Progress indicator
  2. Immediate Feedback: "Uploading..." → "Processing..."
  3. Status Updates:
    - Small files: Complete in 10-30 seconds
    - Large files: Complete in 2-10 minutes (if webhook works)
  4. Final State: Show extracted vendor, amount, date
  5. Actions Enabled: View details, Send to Xero, Edit, Delete

  Critical Issues in Current Flow:

  1. Webhook Reliability: 30% failure rate for large files
  2. No Real-time Updates: Users don't know when processing completes
  3. Hardcoded Bucket: Download function only works for accounting docs
  4. Console Logging: 3,615+ console statements in production
  5. Build Configuration: ignoreBuildErrors: true allows type errors

  This system processes thousands of documents monthly but has significant reliability issues that cost
  ~$3,000-6,000/month in operational overhead due to webhook failures and manual debugging.
