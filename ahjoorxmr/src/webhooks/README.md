# Webhook System

Outbound webhook system for notifying external treasury systems when contributions are verified on-chain.

## Features

- **HMAC-SHA256 Signed Webhooks**: All webhook payloads are signed with per-webhook secrets
- **Automatic Retry Logic**: Failed deliveries retry with exponential backoff (5s, 30s, 120s)
- **Event-Based Notifications**: Subscribe to specific event types
- **Dead-Letter Queue**: Failed deliveries after 3 attempts move to dead-letter queue
- **Test Endpoint**: Validate webhook endpoints with synthetic events
- **Per-User Management**: Each user manages their own webhooks

## API Endpoints

### Create Webhook
```http
POST /webhooks
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "url": "https://api.example.com/webhooks/contributions",
  "eventTypes": ["contribution.verified"]
}
```

**Response:**
```json
{
  "id": "webhook-uuid",
  "userId": "user-uuid",
  "url": "https://api.example.com/webhooks/contributions",
  "eventTypes": ["contribution.verified"],
  "isActive": true,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z"
}
```

**Note:** The webhook `secret` is generated automatically and stored securely. It is NOT returned in the response for security reasons.

### List Webhooks
```http
GET /webhooks
Authorization: Bearer <jwt-token>
```

**Response:**
```json
[
  {
    "id": "webhook-uuid",
    "userId": "user-uuid",
    "url": "https://api.example.com/webhooks/contributions",
    "eventTypes": ["contribution.verified"],
    "isActive": true,
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
]
```

### Delete Webhook
```http
DELETE /webhooks/:id
Authorization: Bearer <jwt-token>
```

**Response:** 204 No Content

### Test Webhook
```http
POST /webhooks/:id/test
Authorization: Bearer <jwt-token>
```

**Response:**
```json
{
  "success": true,
  "statusCode": 200,
  "responseBody": { "received": true },
  "deliveryTime": 145
}
```

## Event Types

### contribution.verified

Triggered when a contribution is successfully verified on-chain.

**Payload Structure:**
```json
{
  "event": "contribution.verified",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "data": {
    "contributionId": "contrib-uuid",
    "groupId": "group-uuid",
    "userId": "user-uuid",
    "walletAddress": "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "amount": "100",
    "roundNumber": 1,
    "transactionHash": "stellar-tx-hash",
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

## HMAC Signature Verification

All webhook requests include an `X-Webhook-Signature` header with the format:
```
X-Webhook-Signature: sha256=<hex-digest>
```

### Verifying Signatures (Receiver Side)

**Node.js Example:**
```javascript
const crypto = require('crypto');

function verifyWebhookSignature(payload, signature, secret) {
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex')}`;
  
  return signature === expectedSignature;
}

// In your webhook handler
app.post('/webhooks/contributions', (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const secret = 'your-webhook-secret'; // Store this securely
  
  if (!verifyWebhookSignature(req.body, signature, secret)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // Process the webhook
  console.log('Contribution verified:', req.body.data);
  res.json({ received: true });
});
```

**Python Example:**
```python
import hmac
import hashlib
import json

def verify_webhook_signature(payload, signature, secret):
    expected_signature = 'sha256=' + hmac.new(
        secret.encode('utf-8'),
        json.dumps(payload).encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    
    return signature == expected_signature

# In your Flask webhook handler
@app.route('/webhooks/contributions', methods=['POST'])
def handle_webhook():
    signature = request.headers.get('X-Webhook-Signature')
    secret = 'your-webhook-secret'  # Store this securely
    
    if not verify_webhook_signature(request.json, signature, secret):
        return {'error': 'Invalid signature'}, 401
    
    # Process the webhook
    print('Contribution verified:', request.json['data'])
    return {'received': True}
```

## Retry Behavior

### Delivery Guarantees and Deduplication

Each payload includes an `event_id` that identifies the logical event. The ID
is stable across delivery attempts and is derived from the event type and event
data, or can be supplied by the producer when replaying a known event. The
`webhook_deliveries` table enforces one logical delivery per webhook and event.

Webhook delivery is **at-least-once**. A successful delivery recorded by
Ahjoor is not sent again when the same event is enqueued. A network timeout
after a subscriber has processed a request can still cause a retry, so
integrators must deduplicate using `event_id` and return a 2xx response for
already-processed events. Retries reuse the same `event_id` and signature
payload; `attemptNumber` identifies the attempt recorded internally.

Webhook deliveries are automatically retried on failure with exponential backoff:

1. **Attempt 1**: Immediate delivery
2. **Attempt 2**: After 5 seconds (if 5xx error or network failure)
3. **Attempt 3**: After 30 seconds (if 5xx error or network failure)
4. **Dead Letter**: After 120 seconds (if all attempts fail)

### Retry Conditions

- **Will Retry**: 5xx status codes, network errors, timeouts
- **Won't Retry**: 2xx, 3xx, 4xx status codes (considered successful or permanent failures)

### Dead Letter Queue

Failed webhooks after all retry attempts are moved to the dead-letter queue for manual inspection and retry.

## Delivery Timing

- Webhooks are dispatched **within 5 seconds** of contribution verification
- Initial delivery attempt is made immediately
- Retries follow exponential backoff schedule

## Security Best Practices

### For Webhook Receivers

1. **Always Verify Signatures**: Never process webhooks without signature verification
2. **Use HTTPS**: Only accept webhooks over HTTPS
3. **Store Secrets Securely**: Use environment variables or secret management systems
4. **Implement Idempotency**: Use `contributionId` to prevent duplicate processing
5. **Respond Quickly**: Return 2xx status within 10 seconds to avoid timeouts
6. **Log Everything**: Keep audit logs of all webhook deliveries

### For Webhook Senders (This System)

1. **Secrets are Auto-Generated**: 64-character random hex strings
2. **Secrets are Never Exposed**: Not returned in API responses
3. **Per-Webhook Secrets**: Each webhook has its own unique secret
4. **Secure Storage**: Secrets stored encrypted in database

## Testing Your Webhook

Use the test endpoint to validate your webhook implementation:

```bash
curl -X POST https://api.ahjoorxmr.com/webhooks/{webhook-id}/test \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

This sends a synthetic `contribution.verified` event to your webhook URL with test data.

## Monitoring

### Check Webhook Status

Monitor webhook deliveries through:
- BullMQ dashboard at `/admin/queues`
- Dead-letter queue for failed deliveries
- Application logs for delivery attempts

### Metrics

The system tracks:
- Delivery success rate
- Average delivery time
- Retry counts
- Dead-letter queue depth

## Troubleshooting

### Webhook Not Receiving Events

1. Check webhook is active: `GET /webhooks`
2. Verify event type subscription includes `contribution.verified`
3. Check your endpoint returns 2xx status code
4. Verify HTTPS certificate is valid
5. Check firewall allows inbound connections

### Signature Verification Failing

1. Ensure you're using the raw request body (not parsed JSON)
2. Verify secret matches the one generated during webhook creation
3. Check signature format: `sha256=<hex>`
4. Ensure HMAC algorithm is SHA-256

### Deliveries Timing Out

1. Respond within 10 seconds
2. Process webhooks asynchronously
3. Return 2xx immediately, process in background

## Example Implementation

Complete webhook receiver example:

```javascript
const express = require('express');
const crypto = require('crypto');
const app = express();

// Store webhook secret securely (from environment or secret manager)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// Middleware to verify webhook signature
function verifyWebhook(req, res, next) {
  const signature = req.headers['x-webhook-signature'];
  const payload = JSON.stringify(req.body);
  
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex')}`;
  
  if (signature !== expectedSignature) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  next();
}

// Webhook endpoint
app.post('/webhooks/contributions', 
  express.json(),
  verifyWebhook,
  async (req, res) => {
    const { event, data } = req.body;
    
    // Respond immediately
    res.json({ received: true });
    
    // Process asynchronously
    if (event === 'contribution.verified') {
      await processContribution(data);
    }
  }
);

async function processContribution(data) {
  console.log('Processing contribution:', data.contributionId);
  // Update your treasury system
  // Send notifications
  // Update accounting records
}

app.listen(3000);
```

## Rate Limits

- Maximum 50 webhook deliveries per minute per queue
- Concurrent deliveries: 5
- Timeout per delivery: 10 seconds

## Support

For issues or questions:
- Check application logs
- Review dead-letter queue
- Contact support with webhook ID and timestamp
