// Shared in-memory store for push subscriptions
// In production, use a database instead

const subscriptions = new Map<string, PushSubscriptionJSON>();

export function getSubscriptions() {
  return subscriptions;
}

export function addSubscription(endpoint: string, sub: PushSubscriptionJSON) {
  subscriptions.set(endpoint, sub);
}

export function removeSubscription(endpoint: string) {
  subscriptions.delete(endpoint);
}

export function getSubscriptionCount() {
  return subscriptions.size;
}
