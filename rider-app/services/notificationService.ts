import { Platform } from 'react-native';

// Note: Push notifications are not supported in Expo Go
// This service provides fallback functionality using toast notifications only
// For full push notification support, use a development build

export interface NotificationData extends Record<string, unknown> {
  orderId?: string;
  type?: 'new_order' | 'payment_confirmed' | 'status_change';
  status?: string;
}

/**
 * Request notification permissions from the user
 * Note: Returns null in Expo Go as push notifications are not supported
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  console.log('Push notifications not available in Expo Go. Using toast notifications only.');
  return null;
}

/**
 * Schedule a local notification
 * Note: Not available in Expo Go - logs to console instead
 */
export async function scheduleLocalNotification(
  title: string,
  body: string,
  data?: NotificationData
): Promise<string> {
  console.log(`[Notification] ${title}: ${body}`);
  return '';
}

/**
 * Cancel all scheduled notifications
 * Note: Not available in Expo Go
 */
export async function cancelAllNotifications(): Promise<void> {
  console.log('[Notification] Cancel all notifications called');
}

/**
 * Set up notification listeners
 * Note: Not available in Expo Go - returns empty cleanup
 */
export function setupNotificationListeners(
  onNotificationReceived?: (notification: any) => void,
  onNotificationTapped?: (response: any) => void
) {
  console.log('[Notification] Listeners setup (Expo Go - no-op)');
  return () => {}; // Return empty cleanup function
}

/**
 * Send a local notification for a new order
 */
export async function notifyNewOrder(orderId: string, customerName: string, amount: number) {
  return scheduleLocalNotification(
    '🆕 New Order Assigned!',
    `New order for delivery - ₱${amount.toFixed(2)}`,
    { orderId, type: 'new_order' }
  );
}

/**
 * Send a local notification for payment confirmation
 */
export async function notifyPaymentConfirmed(orderId: string, customerName: string) {
  return scheduleLocalNotification(
    '✅ Payment Confirmed!',
    `${customerName} has paid via QRPH`,
    { orderId, type: 'payment_confirmed' }
  );
}

/**
 * Send a local notification for status change
 */
export async function notifyStatusChange(orderId: string, customerName: string, newStatus: string) {
  let title = '📦 Order Status Updated';
  let body = `${customerName} - Status: ${newStatus}`;
  
  // Customize notification based on status
  switch(newStatus.toUpperCase()) {
    case 'EN_ROUTE':
    case 'ENROUTE':
      title = '🚗 Trip Started';
      body = `On the way to ${customerName}`;
      break;
    case 'ARRIVED':
      title = '📍 Arrived at Destination';
      body = `You have arrived at the destination`;
      break;
    case 'COMPLETED':
      title = '✅ Delivery Completed';
      body = `Order for ${customerName} completed successfully`;
      break;
  }
  
  return scheduleLocalNotification(
    title,
    body,
    { orderId, type: 'status_change', status: newStatus }
  );
}

/**
 * Send a local notification for trip start
 */
export async function notifyTripStarted(orderId: string, customerName: string) {
  return scheduleLocalNotification(
    '🚗 Trip Started',
    `On the way to ${customerName}`,
    { orderId, type: 'status_change', status: 'EN_ROUTE' }
  );
}

/**
 * Send a local notification for arrival
 */
export async function notifyArrival(orderId: string, customerName: string) {
  return scheduleLocalNotification(
    '📍 Arrived at Destination',
    `You have arrived at the destination`,
    { orderId, type: 'status_change', status: 'ARRIVED' }
  );
}

/**
 * Send a local notification for completion
 */
export async function notifyCompleted(orderId: string, customerName: string) {
  return scheduleLocalNotification(
    '✅ Delivery Completed',
    `Order for ${customerName} completed successfully`,
    { orderId, type: 'status_change', status: 'COMPLETED' }
  );
}
