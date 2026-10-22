/** Extracts identifiers and intent from a merchant's free-text message. */
export function understand(message = '') {
  const txnMatch = message.match(/\bTXN\s?-?(\d{3,})\b/i);
  const merchantMatch = message.match(/\bM\d{3}\b/i);
  const amountMatch = message.match(/(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d+)?)/i);
  return {
    txnId: txnMatch ? `TXN${txnMatch[1]}` : null,
    merchantId: merchantMatch ? merchantMatch[0].toUpperCase() : null,
    amount: amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null,
    wantsRefund: /\brefund\b/i.test(message),
    claimsPaid: /\b(paid|charged|debited|deducted)\b/i.test(message),
    urgent: /\b(urgent|asap|immediately|today)\b/i.test(message),
  };
}
