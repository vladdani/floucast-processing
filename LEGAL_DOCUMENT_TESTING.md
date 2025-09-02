# Legal Document Testing Guide

This guide explains how to test the floucast-processing application specifically with legal documents, including contracts, agreements, legal briefs, and other legal document types.

## Legal Document Processing Differences

### Database Schema
Legal documents use different database tables:
- **Table**: `legal_documents` (instead of `documents`)  
- **Bucket**: `legal-docs` (instead of `documents`)
- **Vertical**: `legal` (instead of `accounting`)

### Processing Focus
Legal document processing emphasizes:
- ✅ **Contract analysis**: Parties, terms, obligations
- ✅ **Legal entity extraction**: Company names, person names, addresses  
- ✅ **Date and deadline extraction**: Contract dates, expiration, milestones
- ✅ **Risk assessment**: Legal risks, compliance issues
- ✅ **Clause identification**: Key clauses, terms, conditions
- ✅ **Document classification**: Contract type, legal document category

## Quick Legal Document Testing

### 1. Start Processing Application
```bash
cd /home/goodsmileduck/local/personal/floucast-processing
npm run dev
```

### 2. Test Legal Document Processing Endpoint
```bash
# Test with legal vertical
curl -X POST http://localhost:8080/process \
  -H "Content-Type: application/json" \
  -d '{
    "s3Key": "legal-docs/contract-001.pdf",
    "bucketName": "floucast-documents", 
    "documentId": "legal-test-001",
    "vertical": "legal",
    "organizationId": "law-firm-test",
    "originalFilename": "service-agreement.pdf",
    "documentType": "application/pdf",
    "fileSize": 245678
  }'
```

### 3. Test Existing Legal Document
```bash
# Test process-document endpoint with legal vertical
curl -X POST http://localhost:8080/process-document \
  -H "Content-Type: application/json" \
  -d '{
    "documentId": "existing-legal-doc-id",
    "vertical": "legal",
    "organizationId": "law-firm-test"
  }'
```

## Legal Document Types to Test

### 1. Service Agreements
**Test Content:**
```
SERVICE AGREEMENT

This Service Agreement ("Agreement") is entered into on January 20, 2024, between:

CLIENT: PT Teknologi Digital Indonesia
Address: Jl. Sudirman No. 123, Jakarta 10250
("Client")

SERVICE PROVIDER: Legal Consulting Services LLC  
Address: 456 Legal Street, Jakarta 12345
("Provider")

TERMS:
- Service Period: 12 months from execution date
- Monthly Fee: USD 5,000
- Termination: 30 days written notice
- Governing Law: Indonesian Law

Key Obligations:
1. Provider shall deliver legal consultation services
2. Client shall pay fees within 15 days of invoice
3. Both parties maintain confidentiality

Effective Date: January 20, 2024
Expiration Date: January 20, 2025

SIGNATURES:
Client: _________________ Date: _________
Provider: _________________ Date: _________
```

**Expected Extraction:**
- **Parties**: PT Teknologi Digital Indonesia, Legal Consulting Services LLC
- **Contract Type**: Service Agreement
- **Value**: USD 5,000 (monthly)
- **Term**: 12 months
- **Key Dates**: 2024-01-20 to 2025-01-20
- **Governing Law**: Indonesian Law

### 2. Non-Disclosure Agreement (NDA)
**Test Content:**
```
MUTUAL NON-DISCLOSURE AGREEMENT

Effective Date: February 15, 2024

Party A: ABC Technology Corp
Address: 789 Tech Park, Jakarta

Party B: XYZ Consulting Ltd
Address: 321 Business Center, Surabaya

PURPOSE: Discussion of potential business collaboration

CONFIDENTIAL INFORMATION includes:
- Technical specifications
- Business strategies  
- Financial information
- Customer data

OBLIGATIONS:
1. Maintain strict confidentiality for 3 years
2. Use information solely for evaluation purposes
3. Return or destroy information upon request

TERM: This agreement shall remain in effect for 3 years from the Effective Date.

LIABILITY: Breach may result in irreparable harm and injunctive relief.

GOVERNING LAW: Republic of Indonesia

Signatures:
Party A: _________________ Date: _________
Party B: _________________ Date: _________
```

**Expected Extraction:**
- **Document Type**: Non-Disclosure Agreement
- **Parties**: ABC Technology Corp, XYZ Consulting Ltd
- **Term**: 3 years
- **Effective Date**: 2024-02-15
- **Purpose**: Business collaboration evaluation
- **Governing Law**: Republic of Indonesia

### 3. Employment Contract
**Test Content:**
```
EMPLOYMENT CONTRACT

Employee: Sarah Johnson
Position: Senior Legal Counsel
Employer: Indonesian Legal Associates
Date: March 1, 2024

TERMS AND CONDITIONS:

1. EMPLOYMENT PERIOD
   Start Date: March 15, 2024
   Contract Type: Permanent Employment

2. COMPENSATION
   Base Salary: IDR 25.000.000 per month
   Performance Bonus: Up to 20% of annual salary
   Benefits: Health insurance, retirement plan

3. RESPONSIBILITIES
   - Provide legal advice to clients
   - Draft and review contracts
   - Represent company in legal matters
   - Supervise junior legal staff

4. WORKING HOURS
   Standard: 40 hours per week
   Monday to Friday, 9:00 AM to 6:00 PM

5. TERMINATION
   Notice Period: 30 days written notice
   Severance: As per Indonesian Labor Law

6. CONFIDENTIALITY
   Employee agrees to maintain confidentiality of all client and company information.

GOVERNING LAW: Indonesian Employment Law

Employee: _________________ Date: _________
Employer: _________________ Date: _________
```

**Expected Extraction:**
- **Document Type**: Employment Contract
- **Employee**: Sarah Johnson
- **Employer**: Indonesian Legal Associates
- **Position**: Senior Legal Counsel
- **Salary**: IDR 25,000,000 per month
- **Start Date**: 2024-03-15
- **Notice Period**: 30 days

### 4. Lease Agreement
**Test Content:**
```
OFFICE LEASE AGREEMENT

LANDLORD: PT Property Management Indonesia
Address: Jl. Properti Utama No. 88, Jakarta

TENANT: Digital Solutions Company
Address: Jl. Bisnis Baru No. 45, Jakarta

PROPERTY: Office Space, Floor 12, Tower A
Address: Jl. Sudirman Plaza, Jakarta
Size: 250 square meters

LEASE TERMS:
- Lease Period: 2 years
- Start Date: April 1, 2024  
- End Date: March 31, 2026
- Monthly Rent: IDR 75.000.000
- Security Deposit: IDR 150.000.000 (2 months rent)
- Service Charge: IDR 15.000.000 per month

PAYMENT TERMS:
- Rent due on 1st of each month
- Late payment penalty: 2% per month
- Annual rent increase: 5%

TENANT OBLIGATIONS:
1. Use premises for office purposes only
2. Maintain property in good condition
3. Obtain landlord approval for alterations
4. Pay utilities and maintenance costs

TERMINATION:
- Early termination requires 3 months notice
- Breach of contract allows immediate termination

GOVERNING LAW: Indonesian Property Law

Landlord: _________________ Date: _________
Tenant: _________________ Date: _________
```

**Expected Extraction:**
- **Document Type**: Lease Agreement
- **Landlord**: PT Property Management Indonesia
- **Tenant**: Digital Solutions Company
- **Property**: Office Space, Floor 12, Tower A
- **Rent**: IDR 75,000,000 per month
- **Term**: 2 years (2024-04-01 to 2026-03-31)
- **Security Deposit**: IDR 150,000,000

## Legal Document Test Scripts

### Create Legal Test Documents
```bash
# Run the legal document creator
npm run test:create-legal-docs
```

This will create:
- `service-agreement.txt`
- `nda-mutual.txt`  
- `employment-contract.txt`
- `lease-agreement.txt`
- `legal-test-data.json`

### Legal Document Processing Test
```bash
# Run comprehensive legal document tests
npm run test:legal-enhanced
```

### S3 Pipeline Test for Legal Documents
```bash
# Test S3 → SQS → Processing for legal documents
npm run test:legal-s3-pipeline
```

## Database Schema for Legal Documents

### Legal Documents Table
```sql
-- Legal documents use this table structure
CREATE TABLE legal_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_filename TEXT,
  file_path TEXT,
  file_size BIGINT,
  document_type TEXT,
  processing_status TEXT DEFAULT 'pending',
  
  -- Legal-specific fields
  parties JSONB,                    -- Array of parties/entities
  contract_type TEXT,               -- Type of legal document
  effective_date DATE,              -- When contract becomes effective
  expiration_date DATE,             -- When contract expires
  governing_law TEXT,               -- Applicable legal jurisdiction
  contract_value DECIMAL,           -- Financial value if applicable
  currency TEXT,                    -- Currency of contract value
  key_terms JSONB,                  -- Important terms and conditions
  obligations JSONB,                -- Obligations for each party
  risks JSONB,                      -- Identified legal risks
  
  -- Processing metadata
  ai_summary TEXT,                  -- AI-generated summary
  structured_data JSONB,            -- Full extracted data
  processed_at TIMESTAMPTZ,         -- When processing completed
  processing_completed_at TIMESTAMPTZ,
  ai_extraction_error TEXT,
  
  -- Standard fields
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Legal document chunks for embedding search
CREATE TABLE legal_document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_document_id UUID REFERENCES legal_documents(id),
  content TEXT,
  embedding vector(1536),  -- For semantic search
  chunk_index INTEGER,
  source_type TEXT DEFAULT 'content'
);
```

### Sample Database Records
After processing legal documents, you should see records like:

```sql
-- Check processed legal documents
SELECT 
  id,
  original_filename,
  processing_status,
  contract_type,
  parties,
  contract_value,
  effective_date,
  expiration_date,
  governing_law
FROM legal_documents 
WHERE processing_status = 'complete'
ORDER BY created_at DESC;

-- Check legal document embeddings
SELECT 
  ld.original_filename,
  ldc.content,
  ldc.chunk_index
FROM legal_documents ld
JOIN legal_document_chunks ldc ON ld.id = ldc.legal_document_id
WHERE ld.processing_status = 'complete'
ORDER BY ld.created_at DESC, ldc.chunk_index;
```

## Legal Document AI Prompts

The system uses specialized prompts for legal documents:

### Legal Document Extraction Prompt
```
You are an expert legal document analyzer. Analyze the provided legal document and extract:

LEGAL DOCUMENT ANALYSIS:

1. DOCUMENT CLASSIFICATION
   - document_type: Type of legal document (Contract, Agreement, NDA, etc.)
   - contract_type: Specific contract category
   - legal_category: Area of law (Employment, Commercial, Real Estate, etc.)

2. PARTIES AND ENTITIES
   - parties: Array of all parties involved with their roles
   - primary_party: Main contracting party
   - secondary_party: Other contracting party
   - legal_entities: Companies, organizations mentioned
   - individuals: People mentioned with their roles

3. KEY DATES AND TERMS  
   - effective_date: When the contract becomes effective
   - expiration_date: When the contract expires
   - execution_date: When the contract was signed
   - key_deadlines: Important milestone dates
   - term_length: Duration of the contract

4. FINANCIAL TERMS
   - contract_value: Total financial value
   - currency: Currency of financial terms
   - payment_terms: Payment schedule and conditions
   - financial_obligations: Money-related obligations

5. LEGAL TERMS
   - governing_law: Applicable law/jurisdiction
   - dispute_resolution: How disputes are handled  
   - termination_conditions: How contract can be terminated
   - liability_clauses: Liability and limitation terms

6. KEY OBLIGATIONS
   - obligations: Array of obligations per party
   - deliverables: What each party must deliver
   - performance_standards: Quality/performance requirements

7. RISKS AND COMPLIANCE
   - identified_risks: Potential legal risks
   - compliance_requirements: Regulatory compliance needs
   - breach_consequences: What happens if contract is breached

8. IMPORTANT CLAUSES
   - confidentiality: Non-disclosure provisions
   - intellectual_property: IP ownership/licensing
   - force_majeure: Unforeseeable circumstances provisions
   - amendment_procedures: How to modify the contract

Return the result as a comprehensive JSON object with these exact keys.
Use null for fields that cannot be determined from the document.

For Indonesian legal documents, extract names and terms as they appear,
but provide English translations in parentheses where helpful for clarity.
```

## Testing Legal Document Processing

### Manual Testing Commands

```bash
# 1. Create legal test document
cat > test-legal-contract.txt << 'EOF'
CONSULTING SERVICES AGREEMENT

This Agreement is made on January 15, 2024 between:

CLIENT: PT Digital Innovation Indonesia
Address: Jl. Technology Hub No. 100, Jakarta 12920

CONSULTANT: Legal Advisory Partners LLC
Address: 500 Legal Plaza, Jakarta 10310

SERVICE DESCRIPTION: Legal consultation and contract drafting services

TERM: 6 months from February 1, 2024 to July 31, 2024

COMPENSATION: USD 8,000 per month, payable within 15 days of invoice

TERMINATION: Either party may terminate with 30 days written notice

GOVERNING LAW: Laws of the Republic of Indonesia

CONFIDENTIALITY: Both parties agree to maintain confidentiality

CLIENT: _________________ Date: _________
CONSULTANT: _________________ Date: _________
EOF

# 2. Upload to S3 for legal processing
aws s3 cp test-legal-contract.txt s3://floucast-documents/legal-docs/contract-$(date +%s).txt \
  --metadata documentId=legal-test-$(date +%s),vertical=legal,organizationId=law-firm

# 3. Or test directly via API
curl -X POST http://localhost:8080/process \
  -H "Content-Type: application/json" \
  -d '{
    "s3Key": "legal-docs/test-contract.txt",
    "bucketName": "floucast-documents",
    "documentId": "legal-contract-001", 
    "vertical": "legal",
    "organizationId": "law-firm-test",
    "originalFilename": "test-legal-contract.txt",
    "documentType": "text/plain"
  }'
```

### Expected Legal Processing Results

For the test contract above, you should get:

```json
{
  "document_type": "Consulting Services Agreement",
  "contract_type": "Service Agreement", 
  "parties": [
    {
      "name": "PT Digital Innovation Indonesia",
      "role": "Client",
      "address": "Jl. Technology Hub No. 100, Jakarta 12920"
    },
    {
      "name": "Legal Advisory Partners LLC", 
      "role": "Consultant",
      "address": "500 Legal Plaza, Jakarta 10310"
    }
  ],
  "effective_date": "2024-02-01",
  "expiration_date": "2024-07-31",
  "contract_value": 48000,
  "currency": "USD",
  "governing_law": "Laws of the Republic of Indonesia",
  "term_length": "6 months",
  "payment_terms": "USD 8,000 per month, payable within 15 days",
  "termination_conditions": "30 days written notice",
  "confidentiality": "Both parties agree to maintain confidentiality"
}
```

## Monitoring Legal Document Processing

### Check Processing Logs
```bash
# Monitor legal document processing
tail -f logs/application.log | grep "legal"

# Check specific legal document
tail -f logs/application.log | grep "legal-contract-001"
```

### Database Verification  
```sql
-- Check recent legal documents
SELECT 
  original_filename,
  contract_type,
  parties,
  effective_date,
  expiration_date,
  contract_value,
  processing_status
FROM legal_documents 
ORDER BY created_at DESC
LIMIT 5;

-- Check legal document chunks for search
SELECT 
  ld.original_filename,
  COUNT(ldc.id) as chunk_count
FROM legal_documents ld
LEFT JOIN legal_document_chunks ldc ON ld.id = ldc.legal_document_id
GROUP BY ld.id, ld.original_filename
ORDER BY ld.created_at DESC;
```

## Legal Document Testing Checklist

### ✅ Document Types Tested
- [ ] Service/Consulting Agreements
- [ ] Non-Disclosure Agreements (NDAs)
- [ ] Employment Contracts
- [ ] Lease/Rental Agreements
- [ ] Purchase/Sale Agreements
- [ ] Partnership Agreements
- [ ] Licensing Agreements
- [ ] Terms of Service/Use

### ✅ Extraction Accuracy
- [ ] Party identification (companies, individuals)
- [ ] Contract dates (effective, expiration, execution)
- [ ] Financial terms (values, payment schedules)
- [ ] Legal jurisdiction and governing law
- [ ] Key obligations and deliverables
- [ ] Termination and dispute resolution clauses
- [ ] Confidentiality and IP provisions

### ✅ Database Integration
- [ ] Legal documents table populated correctly
- [ ] Parties stored as structured JSON
- [ ] Dates parsed and stored properly
- [ ] Financial values extracted accurately
- [ ] Legal document chunks created for search
- [ ] Processing status updated correctly

### ✅ Performance
- [ ] Complex legal documents process within timeout
- [ ] Large contract files handled efficiently
- [ ] Concurrent legal document processing works
- [ ] Memory usage stable during processing
- [ ] Error handling for malformed documents

This comprehensive legal document testing approach ensures your floucast-processing application can handle sophisticated legal document analysis and extraction requirements.