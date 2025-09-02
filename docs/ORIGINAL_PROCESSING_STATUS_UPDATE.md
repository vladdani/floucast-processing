Perfect! Now I have a complete picture. Here's how processing posts status updates:

  Processing Status Updates - Complete Flow

  1. Status Update Mechanism

  Primary Method: Database Updates with Real-time Notifications

  async function emitProcessingStatus(
    documentId: string, 
    status: 'pending' | 'processing' | 'complete' | 'failed',
    progress?: number,
    extractedData?: ExtractedDataPreview,
    error?: string
  ) {
    // Updates documents table with status and progress
    await supabaseAdmin
      .from('documents')
      .update({
        processing_status: status,
        updated_at: new Date().toISOString(),
        description: JSON.stringify(processingInfo) // Temp progress data
      })
      .eq('id', documentId);
  }

  2. Status Update Timeline During Processing

  Progress Stages Posted:

  // Stage 1: Initial processing (10%)
  await emitProcessingStatus(documentId, 'processing', 10);

  // Stage 2: File downloaded, AI starting (25%) 
  await emitProcessingStatus(documentId, 'processing', 25);

  // Stage 3: Text extraction complete (50%)
  await emitProcessingStatus(documentId, 'processing', 50);

  // Stage 4: Full extraction complete (70%)
  await emitProcessingStatus(documentId, 'processing', 70);

  // Stage 5: AI extraction with preview (75%)
  await emitProcessingStatus(documentId, 'processing', 75, extractionPreview);

  // Stage 6: Processing complete (100%)
  await emitProcessingStatus(documentId, 'complete', 100, finalPreview);

  // Error states (0%)
  await emitProcessingStatus(documentId, 'failed', 0, undefined, errorMessage);

  3. Where Status Updates Are Posted

  Database Updates:

  -- Main status tracking in documents table
  UPDATE documents SET
    processing_status = 'processing',  -- pending, processing, complete, failed
    updated_at = NOW(),
    description = '{"progress": 75, "preview": {...}}' -- Temporary progress data
  WHERE id = documentId;

  Real-time Notifications:

  // Frontend subscribes to document changes
  const channel = supabaseClient
    .channel('accounting_document_updates')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'documents',
      filter: `organization_id=eq.${organizationId}`
    }, (payload) => {
      // Real-time status updates received here
      const newDoc = payload.new;

      if (newDoc.processing_status === 'processing') {
        // Start countdown timer, show progress
        startETRCountdown(newDoc.id);
      } else if (newDoc.processing_status === 'complete') {
        // Show success, refresh data
        handleProcessingComplete(newDoc);
      }
    });

  4. Status Information Available

  Progress Data Structure:

  // Stored temporarily in description field during processing
  const processingInfo = {
    progress: 75,                    // 0-100 percentage
    preview: {                       // Live extraction preview
      vendor: "ACME Corp",
      amount: 1500.00,
      currency: "IDR",
      type: "Invoice",
      confidence: 85
    },
    timestamp: "2025-09-02T10:30:00Z"
  };

  5. Frontend Status Detection

  How UI Shows Progress:

  // Real-time status monitoring in dashboard
  useEffect(() => {
    // Supabase realtime subscription detects changes
    if (document.processing_status === 'processing') {
      // Show progress bar, spinner, ETR countdown
      const progressData = JSON.parse(document.description || '{}');
      setProgress(progressData.progress || 0);
      setPreview(progressData.preview);
    } else if (document.processing_status === 'complete') {
      // Show extracted data, enable actions
      setIsComplete(true);
      clearETRTimer();
    }
  }, [document.processing_status]);

  6. Status Posting Locations

  Multiple Update Points:

  1. Initial processing start (10%)
  2. File download complete (25%)
  3. Text extraction done (50%/70%)
  4. AI extraction complete (75%) - includes preview data
  5. Final completion (100%) - with full extracted data
  6. Error states (0%) - with error messages

  Status Fields Updated:

  -- Primary status fields
  processing_status     -- Main status indicator
  updated_at           -- Timestamp of last update
  description          -- Temporary progress/preview data (during processing)

  -- Final data fields (on completion)
  vendor_name          -- Extracted vendor
  total_amount         -- Extracted amount  
  document_date        -- Extracted date
  ai_extracted_data    -- Complete AI response
  processing_time_ms   -- Total processing duration

  7. Real-time User Experience

  User Sees:

  // Live progress updates
  10% → "Processing document..."
  25% → "Analyzing content..."
  50% → "Extracting data..."
  75% → "ACME Corp • $1,500 • 85% confidence" // Live preview!
  100% → "Complete! ACME Corp invoice for $1,500"

  // ETR countdown
  "Estimated time remaining: 23 seconds"

  8. Current Issues with Status System

  Problems:

  1. Large File Processing: No status updates for >10MB files processed via Cloud Run webhook
  2. Webhook Failures: ~30% failure rate means no completion notification
  3. Status Polling: Frontend falls back to polling every 3 seconds when realtime fails
  4. Temporary Data: Progress preview stored in description field (hacky solution)

  Missing Features:

  1. Granular Progress: No byte-by-byte upload progress
  2. Queue Position: No indication of queue position for large files
  3. Retry Status: No automatic retry mechanism status
  4. Background Processing: No way to notify users when they're not actively viewing

  Recommended Improvements:

  1. Replace webhook system with Supabase Real-time for 99.9% reliability
  2. Dedicated progress table instead of hijacking description field
  3. Push notifications for background processing completion
  4. Queue position tracking for better user experience

  The current system works well for small files (≤10MB) with real-time updates, but has significant gaps for large file
  processing due to webhook reliability issues.
