# AWS Cloud Testing Guide

This simple guide shows how to test the floucast-processing application in AWS Cloud by just uploading files to S3.

## Quick Overview

```
📁 Upload file to S3 → 📨 SQS message created → 🖥️ ECS processes document → 💾 Results in database
```

**What happens automatically:**
1. You upload a file to S3
2. S3 sends an event to SQS queue
3. ECS container picks up the SQS message
4. Document gets processed with AI extraction
5. Results are saved to Supabase database

## Prerequisites

### 1. AWS CLI Setup
```bash
# Install AWS CLI (if not installed)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# Configure your credentials
aws configure
# Enter your AWS Access Key ID, Secret Access Key, Region (us-east-1), and output format (json)

# Test connection
aws sts get-caller-identity
```

### 2. Required AWS Resources
Make sure these are set up (see S3_SQS_PIPELINE_SETUP.md for detailed setup):
- ✅ S3 bucket: `floucast-documents`
- ✅ SQS queue: `document-processing-queue` 
- ✅ S3 → SQS event notifications configured
- ✅ ECS service running the floucast-processing app
- ✅ Supabase database accessible

## Testing Methods

### Method 1: Upload Accounting Documents

#### Test Invoice Processing
```bash
# Create a test invoice
cat > test-invoice.txt << 'EOF'
INVOICE

PT Digital Solutions Indonesia
Jl. Technology Hub No. 100, Jakarta 12920
Phone: 021-12345678

Bill To:
PT Client Bahagia  
Jl. Business Center No. 45, Jakarta

Invoice No: INV-2024-001
Date: January 20, 2024
Due Date: February 19, 2024

Description                 Qty    Unit Price      Total
Web Development Service      1      5.000.000      5.000.000
Domain & Hosting            1        500.000        500.000
Monthly Support             3        200.000        600.000

                          Subtotal:    6.100.000
                          Tax (11%):     671.000
                          Total:       6.771.000

Payment Terms: Net 30 days
Bank Account: BCA 1234567890

Thank you for your business!
EOF

# Upload to S3 - this triggers processing automatically
aws s3 cp test-invoice.txt s3://floucast-documents/documents/invoice-$(date +%s).txt \
  --metadata documentId=invoice-test-$(date +%s),vertical=accounting,organizationId=test-company

echo "✅ Invoice uploaded! Processing should start automatically."
```

#### Test Receipt Processing  
```bash
# Create a test receipt
cat > test-receipt.txt << 'EOF'
WARUNG MAKAN SEDERHANA
Jl. Kebon Jeruk No. 789, Jakarta

NOTA: #001234
Tanggal: 20/01/2024
Jam: 14:30

MENU:
Nasi Gudeg       1x    25.000     25.000
Es Teh Manis     2x     5.000     10.000  
Kerupuk          1x     3.000      3.000

                TOTAL:            38.000

TERIMA KASIH
EOF

# Upload receipt
aws s3 cp test-receipt.txt s3://floucast-documents/documents/receipt-$(date +%s).txt \
  --metadata documentId=receipt-test-$(date +%s),vertical=accounting,organizationId=restaurant-test

echo "✅ Receipt uploaded! Check for Indonesian number parsing (25.000 → 25000)."
```

#### Test Bank Statement
```bash
# Create a test bank statement
cat > test-bank-statement.txt << 'EOF'
BANK CENTRAL ASIA
MUTASI REKENING / ACCOUNT STATEMENT

Account No: 1234567890
Account Name: PT TEKNOLOGI DIGITAL
Period: 01 Jan 2024 - 31 Jan 2024

Date       Description                     Debit        Credit       Balance
01/01      SALDO AWAL                                               2.500.000,00
02/01      TRANSFER IN - CLIENT A                      5.000.000    7.500.000,00
03/01      KARTU DEBIT - SUPERMARKET      150.000                  7.350.000,00
05/01      E-BANKING - LISTRIK PLN        200.000                  7.150.000,00
08/01      TRANSFER OUT - SUPPLIER        800.000                  6.350.000,00
10/01      TRANSFER IN - CLIENT B                      3.200.000    9.550.000,00
15/01      ADMIN FEE                       15.000                  9.535.000,00

SALDO AKHIR: 9.535.000,00
EOF

# Upload bank statement
aws s3 cp test-bank-statement.txt s3://floucast-documents/documents/bank-statement-$(date +%s).txt \
  --metadata documentId=bank-test-$(date +%s),vertical=accounting,organizationId=bank-test

echo "✅ Bank statement uploaded! Should extract individual transactions."
```

### Method 2: Upload Legal Documents

#### Test Service Agreement
```bash
# Create a test legal contract
cat > test-service-agreement.txt << 'EOF'
PROFESSIONAL SERVICES AGREEMENT

This Agreement is made on January 15, 2024 between:

CLIENT: PT Digital Innovation Indonesia
Address: Jl. Technology Hub No. 100, Jakarta 12920

CONSULTANT: Legal Advisory Partners LLC
Address: 500 Legal Plaza, Jakarta 10310

SERVICE: Legal consultation and contract drafting services

TERM: 6 months from February 1, 2024 to July 31, 2024

COMPENSATION: USD 8,000 per month, payable within 15 days

TERMINATION: Either party may terminate with 30 days written notice

GOVERNING LAW: Laws of the Republic of Indonesia

CONFIDENTIALITY: Both parties agree to maintain strict confidentiality

CLIENT: _________________ Date: _________
CONSULTANT: _________________ Date: _________
EOF

# Upload to legal documents path
aws s3 cp test-service-agreement.txt s3://floucast-documents/legal-docs/service-agreement-$(date +%s).txt \
  --metadata documentId=legal-test-$(date +%s),vertical=legal,organizationId=law-firm-test

echo "✅ Legal contract uploaded! Should extract parties, terms, and governing law."
```

#### Test Employment Contract
```bash
# Create employment contract
cat > test-employment.txt << 'EOF'
EMPLOYMENT CONTRACT

EMPLOYER: Indonesian Legal Associates
EMPLOYEE: John Smith
POSITION: Legal Counsel
START DATE: March 1, 2024

COMPENSATION:
- Base Salary: IDR 25.000.000 per month
- Performance Bonus: Up to 20% annually
- Benefits: Health insurance, pension

WORKING HOURS: 40 hours per week, Monday to Friday

TERMINATION: 30 days written notice required

GOVERNING LAW: Indonesian Employment Law (Law No. 13/2003)

EMPLOYER: _________________ Date: _________
EMPLOYEE: _________________ Date: _________
EOF

# Upload employment contract
aws s3 cp test-employment.txt s3://floucast-documents/legal-docs/employment-$(date +%s).txt \
  --metadata documentId=employment-test-$(date +%s),vertical=legal,organizationId=law-firm-test

echo "✅ Employment contract uploaded! Should extract salary, terms, and Indonesian law references."
```

### Method 3: Upload Different File Types

#### Upload PDF Document
```bash
# If you have a real PDF invoice/contract
aws s3 cp your-document.pdf s3://floucast-documents/documents/document-$(date +%s).pdf \
  --metadata documentId=pdf-test-$(date +%s),vertical=accounting,organizationId=your-company

echo "✅ PDF uploaded! AI will extract text and analyze content."
```

#### Upload Image Receipt
```bash
# If you have a receipt photo (JPG/PNG)
aws s3 cp receipt-photo.jpg s3://floucast-documents/documents/receipt-$(date +%s).jpg \
  --metadata documentId=image-test-$(date +%s),vertical=accounting,organizationId=your-company

echo "✅ Image uploaded! OCR will extract text from the photo."
```

#### Upload Excel Spreadsheet
```bash
# If you have financial data in Excel
aws s3 cp financial-data.xlsx s3://floucast-documents/documents/excel-$(date +%s).xlsx \
  --metadata documentId=excel-test-$(date +%s),vertical=accounting,organizationId=your-company

echo "✅ Excel file uploaded! Will extract structured data from spreadsheet."
```

## Monitoring Processing Results

### 1. Check SQS Queue Status
```bash
# See if messages are being processed
aws sqs get-queue-attributes \
  --queue-url https://sqs.us-east-1.amazonaws.com/YOUR-ACCOUNT/document-processing-queue \
  --attribute-names ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible

# Expected output:
# ApproximateNumberOfMessages: 0 (no waiting messages)
# ApproximateNumberOfMessagesNotVisible: 0 (no messages being processed)
```

### 2. Check ECS Service Status
```bash
# Check if ECS service is running
aws ecs describe-services \
  --cluster your-cluster-name \
  --services floucast-processing-service

# Look for:
# - runningCount: 1 (or more)
# - desiredCount: 1 (or more)  
# - deploymentStatus: PRIMARY
```

### 3. Check CloudWatch Logs
```bash
# View ECS container logs
aws logs describe-log-groups --log-group-name-prefix /ecs/floucast-processing

# Get recent log events
aws logs get-log-events \
  --log-group-name /ecs/floucast-processing \
  --log-stream-name ecs/floucast-processing/CONTAINER-ID \
  --start-time $(date -d '10 minutes ago' +%s)000

# Look for processing messages like:
# "Starting S3 document processing"
# "Successfully processed document"
```

### 4. Check Supabase Database
```sql
-- Check recently processed documents
SELECT 
  id,
  original_filename,
  processing_status,
  vendor,
  total_amount,
  currency,
  document_type,
  created_at,
  processed_at
FROM documents 
WHERE processing_status IN ('complete', 'processing', 'failed')
ORDER BY created_at DESC 
LIMIT 10;

-- For legal documents, check legal_documents table
SELECT 
  id,
  original_filename,
  processing_status,
  contract_type,
  parties,
  contract_value,
  effective_date,
  governing_law,
  created_at
FROM legal_documents
WHERE processing_status IN ('complete', 'processing', 'failed')
ORDER BY created_at DESC
LIMIT 10;

-- Check extracted line items (for accounting documents)
SELECT 
  d.original_filename,
  li.description,
  li.quantity,
  li.unit_price,
  li.line_total_amount
FROM documents d
JOIN document_line_items li ON d.id = li.document_id
WHERE d.processing_status = 'complete'
ORDER BY d.created_at DESC;
```

## Expected Processing Results

### Invoice Processing Results:
```json
{
  "vendor": "PT Digital Solutions Indonesia",
  "total_amount": 6771000,
  "currency": "IDR", 
  "document_type": "Invoice",
  "document_number": "INV-2024-001",
  "tax_amount": 671000,
  "line_items": [
    {
      "description": "Web Development Service",
      "quantity": 1,
      "unit_price": 5000000,
      "line_total_amount": 5000000
    },
    {
      "description": "Domain & Hosting", 
      "quantity": 1,
      "unit_price": 500000,
      "line_total_amount": 500000
    }
  ]
}
```

### Legal Contract Results:
```json
{
  "document_type": "Professional Services Agreement",
  "parties": [
    {
      "name": "PT Digital Innovation Indonesia",
      "role": "Client"
    },
    {
      "name": "Legal Advisory Partners LLC",
      "role": "Consultant"
    }
  ],
  "contract_value": 48000,
  "currency": "USD",
  "effective_date": "2024-02-01",
  "expiration_date": "2024-07-31",
  "governing_law": "Laws of the Republic of Indonesia"
}
```

### Bank Statement Results:
```json
{
  "vendor": "Bank Central Asia",
  "document_type": "Bank Statement", 
  "document_number": "1234567890",
  "bank_transactions": [
    {
      "transaction_date": "2024-01-02",
      "description": "TRANSFER IN - CLIENT A",
      "credit_amount": 5000000,
      "running_balance": 7500000
    },
    {
      "transaction_date": "2024-01-03", 
      "description": "KARTU DEBIT - SUPERMARKET",
      "debit_amount": 150000,
      "running_balance": 7350000
    }
  ]
}
```

## Troubleshooting

### Issue: Files uploaded but no processing
**Check:**
```bash
# 1. Verify S3 event notifications are configured
aws s3api get-bucket-notification-configuration --bucket floucast-documents

# 2. Check SQS queue for messages
aws sqs get-queue-attributes --queue-url YOUR-QUEUE-URL --attribute-names ApproximateNumberOfMessages

# 3. Verify ECS service is running
aws ecs describe-services --cluster YOUR-CLUSTER --services floucast-processing-service
```

### Issue: Processing fails
**Check:**
```bash
# 1. Check CloudWatch logs for errors
aws logs get-log-events --log-group-name /ecs/floucast-processing --log-stream-name LATEST

# 2. Check Dead Letter Queue for failed messages
aws sqs get-queue-attributes --queue-url YOUR-DLQ-URL --attribute-names ApproximateNumberOfMessages

# 3. Verify database connectivity and credentials
```

### Issue: Wrong database table
**Remember:**
- Accounting documents → `documents` table + `documents/` S3 path
- Legal documents → `legal_documents` table + `legal-docs/` S3 path
- Use correct `vertical` metadata: `accounting` or `legal`

## One-Command Testing

### Test Everything at Once
```bash
# Create and upload multiple test documents
cat > upload-test-suite.sh << 'EOF'
#!/bin/bash

echo "🚀 Uploading test document suite to AWS S3..."

# Test invoice
echo "Test Invoice - Total: Rp 1.234.567,89" > test-invoice-$(date +%s).txt
aws s3 cp test-invoice-*.txt s3://floucast-documents/documents/ \
  --metadata documentId=invoice-$(date +%s),vertical=accounting

# Test receipt  
echo "WARUNG FOOD - Total: 45.000" > test-receipt-$(date +%s).txt
aws s3 cp test-receipt-*.txt s3://floucast-documents/documents/ \
  --metadata documentId=receipt-$(date +%s),vertical=accounting

# Test legal contract
echo "SERVICE AGREEMENT - Value: USD 10,000" > test-contract-$(date +%s).txt  
aws s3 cp test-contract-*.txt s3://floucast-documents/legal-docs/ \
  --metadata documentId=legal-$(date +%s),vertical=legal

echo "✅ All test documents uploaded!"
echo "💡 Check Supabase database in 2-3 minutes for processing results."

# Cleanup local files
rm -f test-*.txt
EOF

chmod +x upload-test-suite.sh
./upload-test-suite.sh
```

## Summary

**To test in AWS Cloud:**

1. **Upload file to S3** with proper metadata
2. **Wait 1-3 minutes** for processing
3. **Check Supabase database** for results
4. **Monitor CloudWatch logs** if issues occur

**Key points:**
- Use `documents/` path for accounting, `legal-docs/` for legal
- Include proper metadata: `documentId`, `vertical`, `organizationId`
- Indonesian number parsing: `1.234.567,89` → `1234567.89`
- Processing is automatic - just upload and wait!

That's it! No complex setup needed - just upload files to S3 and the system processes them automatically.