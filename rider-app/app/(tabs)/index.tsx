import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, FlatList, TouchableOpacity, Button, Alert, Image, ScrollView, ActivityIndicator } from 'react-native';
import { supabase } from '../../supabaseClient';
import QRCode from 'react-native-qrcode-svg';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '@/contexts/AuthContext';
import { captureCurrentLocation, formatCoordinates } from '@/services/locationService';
import ToastNotification, { ToastType } from '@/components/ToastNotification';
import { 
  registerForPushNotificationsAsync, 
  setupNotificationListeners,
  notifyNewOrder,
  notifyPaymentConfirmed,
  notifyTripStarted,
  notifyArrival,
  notifyCompleted
} from '@/services/notificationService';
import * as Haptics from 'expo-haptics';

interface Order {
  id: string;
  customer_name: string;
  address: string;
  cod_amount: number;
  status: string;
  created_at: string;
  proof_url?: string;
  qr_ph?: string | null;
  qr_expires_at?: string | null;
  qr_generated_at?: string | null;
  payrex_payment_intent_id?: string | null;
}

interface ToastState {
  visible: boolean;
  message: string;
  type: ToastType;
}

export default function HomeScreen() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [qrExpiresAt, setQrExpiresAt] = useState<Date | null>(null);
  const [qrTimeRemaining, setQrTimeRemaining] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [activeTab, setActiveTab] = useState<'active' | 'completed'>('active');
  const [toast, setToast] = useState<ToastState>({ visible: false, message: '', type: 'info' });
  const { user, signOut } = useAuth();
  const orderIdsRef = useRef<Set<string>>(new Set());
  const notifiedStatusRef = useRef<Map<string, Set<string>>>(new Map()); // Track notified statuses per order
  const qrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Toast helper function
  const showToast = (message: string, type: ToastType = 'info') => {
    Haptics.notificationAsync(
      type === 'success' ? Haptics.NotificationFeedbackType.Success :
      type === 'error' ? Haptics.NotificationFeedbackType.Error :
      Haptics.NotificationFeedbackType.Warning
    );
    setToast({ visible: true, message, type });
  };

  // QR Timer - Count down to expiry and auto-regenerate
  useEffect(() => {
    if (qrExpiresAt && qrValue) {
      const now = new Date();
      const timeUntilExpiry = Math.floor((qrExpiresAt.getTime() - now.getTime()) / 1000);
      console.log('⏱️ QR Timer STARTED');
      console.log(`   Expires at: ${qrExpiresAt.toLocaleTimeString()}`);
      console.log(`   Time remaining: ${Math.floor(timeUntilExpiry / 60)}m ${timeUntilExpiry % 60}s`);
      console.log(`   Auto-refresh: ENABLED`);
      
      // Clear any existing timer
      if (qrTimerRef.current) {
        clearInterval(qrTimerRef.current);
      }

      // Update timer every second
      qrTimerRef.current = setInterval(() => {
        const now = new Date().getTime();
        const expiryTime = qrExpiresAt.getTime();
        const remaining = Math.max(0, Math.floor((expiryTime - now) / 1000));
        
        setQrTimeRemaining(remaining);
        
        // Log every 30 seconds
        if (remaining % 30 === 0 && remaining > 0) {
          console.log(`⏱️ QR expires in ${Math.floor(remaining / 60)}m ${remaining % 60}s`);
        }
        
        // Warning at 1 minute
        if (remaining === 60) {
          console.log('⚠️ QR code expires in 1 minute!');
          showToast('⚠️ QR expires in 1 minute', 'warning');
        }
        
        // Auto-regenerate when expired
        if (remaining === 0) {
          console.log('❌❌❌ QR EXPIRED! TRIGGERING AUTO-REGENERATION ❌❌❌');
          showToast('🔄 QR expired! Generating new code...', 'warning');
          
          // Clear the interval to prevent multiple triggers
          if (qrTimerRef.current) {
            clearInterval(qrTimerRef.current);
            qrTimerRef.current = null;
          }
          
          // Use current selected order from state
          setSelectedOrder(currentOrder => {
            if (currentOrder) {
              console.log(`🔄 Auto-regenerating QR for order ${currentOrder.id}...`);
              handleGenerateQR(currentOrder, true); // true = auto-regenerate
            } else {
              console.error('❌ Cannot auto-regenerate: No selected order');
            }
            return currentOrder;
          });
        }
      }, 1000);

      return () => {
        if (qrTimerRef.current) {
          clearInterval(qrTimerRef.current);
          console.log('⏱️ QR Timer STOPPED (cleanup)');
        }
      };
    } else {
      console.log('⏱️ QR Timer NOT started - missing qrExpiresAt or qrValue');
    }
  }, [qrExpiresAt, qrValue]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (qrTimerRef.current) {
        clearInterval(qrTimerRef.current);
      }
    };
  }, []);

  // 1. Setup Push Notifications on Load
  useEffect(() => {
    registerForPushNotificationsAsync();
    
    const cleanup = setupNotificationListeners(
      (notification) => {
        // Handle notification received while app is open
        console.log('Notification received in foreground:', notification);
      },
      (response) => {
        // Handle notification tap
        console.log('User tapped notification:', response);
        const data = response.notification.request.content.data;
        if (data.orderId) {
          // Navigate to order detail if needed
          console.log('Navigate to order:', data.orderId);
        }
      }
    );

    return cleanup;
  }, []);

  // 2. Fetch Orders on Load and Real-time Sync
  useEffect(() => {
    // Only fetch orders if user is logged in
    if (user?.id) {
      fetchOrders();
    }

    // 3. Real-time Subscription: Listen for INSERT (new orders) and UPDATE (status changes)
    const ordersChannel = supabase
      .channel('rider-orders-realtime')
      .on(
        'postgres_changes',
        { 
          event: 'INSERT', 
          schema: 'public', 
          table: 'orders',
          filter: `rider_id=eq.${user?.id}`
        },
        async (payload: any) => {
          console.log('🆕 NEW ORDER DETECTED:', payload.new);
          const newOrder = payload.new as Order;
          
          // Check if we've already seen this order (prevent duplicates)
          if (!orderIdsRef.current.has(newOrder.id)) {
            orderIdsRef.current.add(newOrder.id);
            
            // Show toast notification
            showToast(
              `New order for delivery - ₱${newOrder.cod_amount.toFixed(2)}`,
              'info'
            );
            
            // Send push notification
            await notifyNewOrder(newOrder.id, newOrder.customer_name, newOrder.cod_amount);
            
            // Refresh orders list
            fetchOrders();
          }
        }
      )
      .on(
        'postgres_changes',
        { 
          event: 'UPDATE', 
          schema: 'public', 
          table: 'orders',
          filter: `rider_id=eq.${user?.id}`
        },
        async (payload: any) => {
          console.log('📦 ORDER UPDATED:', payload.new);
          const updatedOrder = payload.new as Order;
          const oldOrder = payload.old as Order;
          
          // Check if status changed
          if (oldOrder.status !== updatedOrder.status) {
            // Handle PAID status
            if (updatedOrder.status === 'PAID') {
              showToast(
                `✅ Payment confirmed for ${updatedOrder.customer_name}!`,
                'success'
              );
              await notifyPaymentConfirmed(updatedOrder.id, updatedOrder.customer_name);
              
              // If viewing this order, update it and clear QR
              setSelectedOrder(prev => {
                if (prev && prev.id === updatedOrder.id) {
                  setQrValue(null);
                  setQrExpiresAt(null);
                  setQrTimeRemaining(null);
                  // Auto-complete the order
                  supabase.from('orders').update({ status: 'COMPLETED' }).eq('id', updatedOrder.id);
                  return updatedOrder;
                }
                return prev;
              });
            }
            // Handle EN_ROUTE status
            else if (updatedOrder.status === 'EN_ROUTE' || updatedOrder.status === 'ENROUTE') {
              const statusKey = `${updatedOrder.id}_EN_ROUTE`;
              const orderStatuses = notifiedStatusRef.current.get(updatedOrder.id) || new Set();
              if (!orderStatuses.has(statusKey)) {
                showToast(
                  `🚗 Trip started for ${updatedOrder.customer_name}`,
                  'info'
                );
                await notifyTripStarted(updatedOrder.id, updatedOrder.customer_name);
                orderStatuses.add(statusKey);
                notifiedStatusRef.current.set(updatedOrder.id, orderStatuses);
              }
            }
            // Handle ARRIVED status
            else if (updatedOrder.status === 'ARRIVED') {
              const statusKey = `${updatedOrder.id}_ARRIVED`;
              const orderStatuses = notifiedStatusRef.current.get(updatedOrder.id) || new Set();
              if (!orderStatuses.has(statusKey)) {
                showToast(
                  `📍 Arrived at destination`,
                  'info'
                );
                await notifyArrival(updatedOrder.id, updatedOrder.customer_name);
                orderStatuses.add(statusKey);
                notifiedStatusRef.current.set(updatedOrder.id, orderStatuses);
              }
            }
            // Handle COMPLETED status
            else if (updatedOrder.status === 'COMPLETED') {
              showToast(
                `✅ Order completed for ${updatedOrder.customer_name}`,
                'success'
              );
              await notifyCompleted(updatedOrder.id, updatedOrder.customer_name);
            }
            // Handle other status changes
            else {
              showToast(
                `Order status updated: ${updatedOrder.status}`,
                'info'
              );
            }
          }
          
          // Update selected order if it's the one being viewed
          setSelectedOrder(prev => {
            if (prev && prev.id === updatedOrder.id) {
              return updatedOrder;
            }
            return prev;
          });
          
          // Refresh the list
          fetchOrders();
        }
      )
      .subscribe((status) => {
        console.log('Real-time subscription status:', status);
        if (status === 'SUBSCRIBED') {
          console.log('✅ Successfully subscribed to real-time order updates');
        }
      });

    return () => { 
      supabase.removeChannel(ordersChannel);
      console.log('🔌 Unsubscribed from real-time updates');
    };
  }, [user?.id]);

  const fetchOrders = async () => {
    // Guard clause: Don't fetch if no user
    if (!user?.id) {
      console.log('No user logged in, skipping order fetch');
      setOrders([]);
      return;
    }

    // Fetch orders for the current logged-in rider only
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('rider_id', user.id)
      .order('created_at', { ascending: false });
    
    if (error) {
      console.error('Error fetching orders:', error);
    }
    if (!error && data) {
      console.log(`Fetched ${data.length} orders for rider ${user.email}`);
      setOrders(data);
      
      // Track all order IDs to prevent duplicate notifications
      data.forEach(order => orderIdsRef.current.add(order.id));
    }
  };

  // 3. Update Order Status
  const updateOrderStatus = async (orderId: string, newStatus: string) => {
    const { error } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', orderId);
    
    if (error) {
      console.error('Error updating status:', error);
      showToast('Failed to update order status', 'error');
      return false;
    }
    
    // Show toast and send notification for status updates (only once per status)
    if (newStatus === 'EN_ROUTE') {
      showToast('🚗 Trip started! On the way to customer', 'info');
      if (selectedOrder) {
        const statusKey = `${orderId}_${newStatus}`;
        const orderStatuses = notifiedStatusRef.current.get(orderId) || new Set();
        if (!orderStatuses.has(statusKey)) {
          await notifyTripStarted(orderId, selectedOrder.customer_name);
          orderStatuses.add(statusKey);
          notifiedStatusRef.current.set(orderId, orderStatuses);
        }
      }
    } else if (newStatus === 'ARRIVED') {
      showToast('📍 Marked as arrived at destination', 'success');
      if (selectedOrder) {
        const statusKey = `${orderId}_${newStatus}`;
        const orderStatuses = notifiedStatusRef.current.get(orderId) || new Set();
        if (!orderStatuses.has(statusKey)) {
          await notifyArrival(orderId, selectedOrder.customer_name);
          orderStatuses.add(statusKey);
          notifiedStatusRef.current.set(orderId, orderStatuses);
        }
      }
    }
    
    // Update local state
    setSelectedOrder(prev => prev ? { ...prev, status: newStatus } : null);
    fetchOrders();
    return true;
  };

  // 4. Generate QR Code (with expiry tracking)
  const handleGenerateQR = async (order: Order, isAutoRegenerate: boolean = false) => {
    console.log(`🔄 ${isAutoRegenerate ? 'AUTO-REGENERATING' : 'GENERATING'} QR code for order ${order.id}`);
    setLoading(true);
    setImageError(false);
    try {
      console.log('Invoking generate-qr with:', { orderId: order.id, amount: order.cod_amount });
      
      // Try to call the Supabase function
      const { data, error } = await supabase.functions.invoke('generate-qr', {
        body: { orderId: order.id, amount: order.cod_amount }
      });

      // Use mock QR for development/hackathon (PayRex not configured)
      if (error || !data || !data.qr_url) {
        console.log('📱 Using test QR code (PayRex not configured)');
        
        // Generate a mock payment QR code for testing
        const now = new Date();
        const mockExpiry = new Date(now.getTime() + 5 * 60 * 1000);
        const mockGenerated = now.toISOString();
        const mockExpiryISO = mockExpiry.toISOString();
        
        // Create mock payment data
        const mockPaymentData = {
          merchant: 'Rider App',
          order_id: order.id,
          amount: order.cod_amount,
          currency: 'PHP',
          payment_type: 'QRPH'
        };
        
        // Generate QR code image URL using free service
        const mockQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(JSON.stringify(mockPaymentData))}`;
        
        console.log(`⏱️ Mock QR will expire at: ${mockExpiry.toLocaleTimeString()}`);
        console.log(`⏱️ Setting expiry state and database for order ID: ${order.id}`);
        console.log('Expiry data:', { mockGenerated, mockExpiryISO });
        
        // Update database with mock QR metadata
        const { data: updateData, error: updateError } = await supabase.from('orders').update({ 
          qr_ph: mockQrUrl,
          qr_generated_at: mockGenerated,
          qr_expires_at: mockExpiryISO,
          payrex_payment_intent_id: `mock_${Date.now()}`
        }).eq('id', order.id).select();
        
        if (updateError) {
          console.warn('⚠️ Could not save QR metadata:', updateError.message);
        } else {
          console.log('✅ QR code ready - expires at', mockExpiry.toLocaleTimeString());
        }
        
        // Set state
        setQrValue(mockQrUrl);
        setQrExpiresAt(mockExpiry);
        setQrTimeRemaining(5 * 60); // Initialize to 5 minutes
        
        if (!isAutoRegenerate) {
          Alert.alert(
            "QR Code Ready", 
            `QR code generated for testing.\n\nExpires in 5 minutes at ${mockExpiry.toLocaleTimeString()}`
          );
        } else {
          showToast(`🔄 QR refreshed (expires ${mockExpiry.toLocaleTimeString()})`, 'success');
        }
      } else {
        console.log('✅ QR URL received:', data.qr_url);
        setQrValue(data.qr_url);
        
        // Set expiry time from response
        if (data.expires_at) {
          const expiryDate = new Date(data.expires_at);
          const now = new Date();
          const secondsRemaining = Math.floor((expiryDate.getTime() - now.getTime()) / 1000);
          
          setQrExpiresAt(expiryDate);
          setQrTimeRemaining(secondsRemaining); // Initialize timer immediately
          console.log(`⏱️ QR will expire at: ${expiryDate.toLocaleTimeString()} (${secondsRemaining}s remaining)`);
          
          if (isAutoRegenerate) {
            showToast(`🔄 New QR generated (expires at ${expiryDate.toLocaleTimeString()})`, 'success');
          }
        }
        
        // Update database with QR metadata
        const { data: updateData, error: updateError } = await supabase.from('orders').update({ 
          qr_ph: data.qr_url,
          qr_generated_at: data.generated_at || new Date().toISOString(),
          qr_expires_at: data.expires_at,
          payrex_payment_intent_id: data.payrex_id
        }).eq('id', order.id).select();
        
        if (updateError) {
          console.warn('⚠️ Could not save QR metadata:', updateError.message);
        } else {
          console.log('✅ QR code ready');
        }
      }
      
      // Update payment_method to QRPH (status remains ARRIVED)
      // Mark this status as already notified to prevent duplicate notifications
      const statusKey = `${order.id}_ARRIVED`;
      const orderStatuses = notifiedStatusRef.current.get(order.id) || new Set();
      orderStatuses.add(statusKey);
      notifiedStatusRef.current.set(order.id, orderStatuses);
      
      await supabase.from('orders').update({ 
        payment_method: 'QRPH'
      }).eq('id', order.id);
      
      console.log(`✅ QR generation complete! ${isAutoRegenerate ? '(Auto-regenerated)' : ''}`);
      
    } catch (err: any) {
      console.log('📱 Generating test QR code');
      
      // Fallback to mock QR code for testing
      const now = new Date();
      const mockExpiry = new Date(now.getTime() + 5 * 60 * 1000);
      const mockExpiryISO = mockExpiry.toISOString();
      
      // Create mock payment data
      const mockPaymentData = {
        merchant: 'Rider App',
        order_id: order.id,
        amount: order.cod_amount,
        currency: 'PHP',
        payment_type: 'QRPH'
      };
      
      // Generate QR code image URL
      const mockQrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(JSON.stringify(mockPaymentData))}`;
      
      // Update database with mock expiry
      const { error: updateError } = await supabase.from('orders').update({ 
        qr_ph: mockQrUrl,
        qr_generated_at: now.toISOString(),
        qr_expires_at: mockExpiryISO,
        payrex_payment_intent_id: `mock_error_${Date.now()}`
      }).eq('id', order.id);
      
      if (updateError) {
        console.warn('⚠️ Could not save QR metadata:', updateError.message);
      }
      
      setQrValue(mockQrUrl);
      setQrExpiresAt(mockExpiry);
      setQrTimeRemaining(5 * 60); // Initialize to 5 minutes
      
      if (!isAutoRegenerate) {
        Alert.alert(
          "QR Code Ready", 
          `Test QR code generated for development.\n\nExpires in 5 minutes at ${mockExpiry.toLocaleTimeString()}`
        );
      }
    } finally {
      setLoading(false);
    }
  };

  // 5. Proof of Delivery (Photo) + GPS Capture
  const handlePOD = async (orderId: string, paymentMethod: 'CASH' | 'QRPH' = 'CASH', cashReason?: string) => {
    try {
      // Step 1: Capture GPS coordinates first
      console.log('Capturing delivery location...');
      showToast('📍 Capturing GPS location...', 'info');
      const location = await captureCurrentLocation();
      
      if (location) {
        console.log('Location captured:', formatCoordinates(location.latitude, location.longitude));
      } else {
        console.warn('Location not available, proceeding without GPS');
      }

      // Step 2: Take delivery proof photo
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.5,
        base64: false,
      });

      if (result.canceled) {
        // User canceled - show message that they need to upload proof
        console.log('Photo capture canceled by user');
        Alert.alert(
          "Proof Required",
          "You must upload a proof of delivery photo to complete this transaction.",
          [
            { text: "Try Again", onPress: () => handlePOD(orderId, paymentMethod, cashReason) },
            { 
              text: "Cancel", 
              style: "cancel",
              onPress: () => {
                // Return to payment method selection by clearing QR
                setQrValue(null);
                showToast('Returned to payment selection', 'info');
              }
            }
          ]
        );
        return;
      }

      const file = result.assets[0];
      const fileName = `${orderId}_${Date.now()}.jpg`;

      console.log('Uploading file:', fileName, 'from URI:', file.uri);
      
      // Show loading state
      setLoading(true);
      showToast('⏳ Uploading proof of delivery...', 'info');

      // For React Native, we need to use FormData or ArrayBuffer
      // Let's try using the file URI directly with fetch and ArrayBuffer
      const response = await fetch(file.uri);
      const arrayBuffer = await response.arrayBuffer();
      
      console.log('File size:', arrayBuffer.byteLength, 'bytes');

      // Upload to Supabase Storage using ArrayBuffer
      const { data, error } = await supabase.storage
        .from('proofs')
        .upload(fileName, arrayBuffer, {
          contentType: 'image/jpeg',
          upsert: false,
        });

      if (error) {
        console.error('Upload error:', error);
        
        // Check if it's a bucket not found error
        if (error.message?.includes('Bucket not found') || error.message?.includes('bucket')) {
          Alert.alert(
            "Storage Not Set Up", 
            "The 'proofs' storage bucket doesn't exist.\n\nPlease create it in Supabase Dashboard:\n1. Go to Storage\n2. Create bucket 'proofs'\n3. Make it public\n\nFor now, marking as completed without proof."
          );
          
          // Complete order without proof URL but with GPS and cash reason
          const updateData: any = { 
            status: 'COMPLETED', 
            proof_url: 'no_storage_configured',
            payment_method: paymentMethod,
            delivery_latitude: location?.latitude,
            delivery_longitude: location?.longitude,
            delivery_timestamp: location?.timestamp.toISOString()
          };
          
          // Add cash_fallback_reason if payment is CASH
          if (paymentMethod === 'CASH' && cashReason) {
            updateData.cash_fallback_reason = cashReason;
          }
          
          const { error: updateError } = await supabase
            .from('orders')
            .update(updateData)
            .eq('id', orderId);
          
          if (!updateError) {
            showToast('✅ Delivery completed!', 'success');
            setLoading(false);
            setSelectedOrder(null);
            fetchOrders();
          } else {
            setLoading(false);
          }
          return;
        }
        
        showToast(error.message || 'Failed to upload image', 'error');
        setLoading(false);
        return;
      }

      console.log('Upload successful:', data);
      showToast('✓ Photo uploaded successfully', 'success');

      // Get Public URL
      const { data: publicData } = supabase.storage.from('proofs').getPublicUrl(fileName);
      
      console.log('Public URL:', publicData.publicUrl);

      // Step 3: Update Order with proof URL, payment method, GPS coordinates, and cash reason
      showToast('💾 Completing delivery...', 'info');
      
      const updateData: any = { 
        status: 'COMPLETED', 
        proof_url: publicData.publicUrl,
        payment_method: paymentMethod,
        delivery_latitude: location?.latitude,
        delivery_longitude: location?.longitude,
        delivery_timestamp: location?.timestamp.toISOString()
      };
      
      // Add cash_fallback_reason if payment is CASH
      if (paymentMethod === 'CASH' && cashReason) {
        updateData.cash_fallback_reason = cashReason;
      }
      
      const { error: updateError } = await supabase
        .from('orders')
        .update(updateData)
        .eq('id', orderId);
      
      if (updateError) {
        console.error('Update error:', updateError);
        showToast('Failed to update order', 'error');
        setLoading(false);
        return;
      }
      
      showToast('✅ Delivery completed!', 'success');
      
      setLoading(false);
      setSelectedOrder(null); // Go back to list
      setQrValue(null);
      setQrExpiresAt(null);
      setQrTimeRemaining(null);
      if (qrTimerRef.current) {
        clearInterval(qrTimerRef.current);
      }
      fetchOrders();
    } catch (err: any) {
      console.error('POD error:', err);
      showToast(err.message || 'Failed to complete delivery', 'error');
      setLoading(false);
    }
  };

  // --- RENDERING ---

  // Helper function for status colors
  const getStatusColor = (status: string) => {
    switch(status.toUpperCase()) {
      case 'COMPLETED': return '#28a745';      // Green
      case 'PAID': return '#17a2b8';           // Teal
      case 'PENDING': return '#ffc107';        // Yellow - Awaiting rider to start
      case 'EN_ROUTE': return '#007bff';       // Blue - On the way
      case 'ENROUTE': return '#007bff';        // Blue (alternate spelling)
      case 'ARRIVED': return '#fd7e14';        // Orange - Ready for payment
      default: return '#6c757d';               // Gray (default)
    }
  };

  // Get greeting based on time of day
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  // Get rider name from email (first part before @)
  const getRiderName = () => {
    if (!user?.email) return 'Rider';
    const name = user.email.split('@')[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  };

  // Filter orders based on active tab
  const filteredOrders = orders.filter(order => {
    if (activeTab === 'active') {
      return order.status !== 'COMPLETED';
    } else {
      return order.status === 'COMPLETED';
    }
  });

  // Screen 1: The List
  if (!selectedOrder) {
    return (
      <View style={styles.container}>
        {/* Toast Notification */}
        <ToastNotification
          visible={toast.visible}
          message={toast.message}
          type={toast.type}
          onHide={() => setToast({ ...toast, visible: false })}
        />
        
        {/* Loading Overlay */}
        {loading && (
          <View style={styles.loadingOverlay}>
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color="#007AFF" />
              <Text style={styles.loadingText}>Processing...</Text>
            </View>
          </View>
        )}
        
        <View style={styles.headerContainer}>
          <Text style={styles.header}>{getGreeting()}, {getRiderName()}!</Text>
          <TouchableOpacity 
            style={styles.logoutButton}
            onPress={() => {
              Alert.alert(
                'Logout',
                'Are you sure you want to logout?',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { 
                    text: 'Logout', 
                    style: 'destructive',
                    onPress: () => {
                      signOut().catch(err => {
                        console.error('Logout error:', err);
                        Alert.alert('Error', 'Failed to logout');
                      });
                    }
                  },
                ]
              );
            }}>
            <Text style={styles.logoutText}>Logout</Text>
          </TouchableOpacity>
        </View>
        {user && (
          <Text style={styles.userEmail}>Logged in as: {user.email}</Text>
        )}
        
        {/* Tab Filter */}
        <View style={styles.tabContainer}>
          <TouchableOpacity 
            style={[styles.tab, activeTab === 'active' && styles.activeTab]}
            onPress={() => setActiveTab('active')}
          >
            <Text style={[styles.tabText, activeTab === 'active' && styles.activeTabText]}>
              Active
            </Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={[styles.tab, activeTab === 'completed' && styles.activeTab]}
            onPress={() => setActiveTab('completed')}
          >
            <Text style={[styles.tabText, activeTab === 'completed' && styles.activeTabText]}>
              Completed
            </Text>
          </TouchableOpacity>
        </View>
        
        <FlatList
          data={filteredOrders}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            return (
              <TouchableOpacity 
                style={styles.card} 
                onPress={() => {
                  setSelectedOrder(item);
                  // Load QR data if exists and hasn't expired
                  if (item.qr_ph && item.qr_expires_at) {
                    const expiryDate = new Date(item.qr_expires_at);
                    const now = new Date();
                    const secondsRemaining = Math.floor((expiryDate.getTime() - now.getTime()) / 1000);
                    
                    console.log('📋 Loading existing QR from order');
                    console.log('   QR Value:', item.qr_ph?.substring(0, 50) + '...');
                    console.log('   Expires at:', item.qr_expires_at);
                    console.log('   Parsed expiry:', expiryDate.toLocaleTimeString());
                    console.log('   Seconds remaining:', secondsRemaining);
                    
                    if (secondsRemaining > 0) {
                      setQrExpiresAt(expiryDate);
                      setQrTimeRemaining(secondsRemaining);
                      setQrValue(item.qr_ph);
                    } else {
                      console.log('⚠️ QR already expired');
                      setQrExpiresAt(null);
                      setQrTimeRemaining(null);
                      setQrValue(null);
                    }
                  } else {
                    console.log('📋 No active QR found in order');
                    setQrExpiresAt(null);
                    setQrTimeRemaining(null);
                    setQrValue(null);
                  }
                }}
              >
                <View style={styles.cardRow}>
                  <Text style={styles.orderNumber}>Order #{item.id.slice(0, 8)}</Text>
                  <Text style={styles.amount}>₱{item.cod_amount.toFixed(2)}</Text>
                  <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) }]}>
                    <Text style={styles.statusText}>{item.status}</Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      </View>
    );
  }

  // Screen 2: Detail & Actions
  return (
    <View style={{ flex: 1 }}>
      {/* Toast Notification */}
      <ToastNotification
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        onHide={() => setToast({ ...toast, visible: false })}
      />
      
      {/* Loading Overlay */}
      {loading && (
        <View style={styles.loadingOverlay}>
          <View style={styles.loadingBox}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Processing...</Text>
          </View>
        </View>
      )}
      
      <ScrollView 
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        <TouchableOpacity 
          style={styles.backButton}
          onPress={() => { 
            setSelectedOrder(null); 
            setQrValue(null); 
            setQrExpiresAt(null);
            setQrTimeRemaining(null);
            setImageError(false);
            if (qrTimerRef.current) {
              clearInterval(qrTimerRef.current);
            }
          }}
        >
          <Text style={styles.backButtonText}>← Back</Text>
        </TouchableOpacity>
      
      <View style={styles.detailBox}>
        {/* Header with Order ID and Status Badge */}
        <View style={styles.detailHeader}>
          <Text style={styles.orderIdText}>Order #{selectedOrder.id.slice(0, 8)}</Text>
          <View style={[styles.statusBadgeDetail, { backgroundColor: getStatusColor(selectedOrder.status) }]}>
            <Text style={styles.statusTextDetail}>{selectedOrder.status}</Text>
          </View>
        </View>
        
        <View style={styles.divider} />
        
        {/* Customer Info and Address in Row */}
        <View style={styles.infoRow}>
          <View style={styles.infoColumn}>
            <Text style={styles.detailLabel}>👤 Customer</Text>
            <Text style={styles.detailValue}>{selectedOrder.customer_name}</Text>
          </View>
          <View style={[styles.infoColumn, { flex: 1.5 }]}>
            <Text style={styles.detailLabel}>📍 Delivery Address</Text>
            <Text style={styles.detailAddress}>{selectedOrder.address}</Text>
          </View>
        </View>
        
        <View style={styles.divider} />
        
        {/* Amount - Highlighted */}
        <View style={styles.amountSection}>
          <Text style={styles.amountLabel}>Amount to Collect</Text>
          <Text style={styles.amountLarge}>₱{selectedOrder.cod_amount.toFixed(2)}</Text>
        </View>
      </View>

      {/* STEP 1: Start Delivery (PENDING → EN_ROUTE) */}
      {selectedOrder.status?.toUpperCase() === 'PENDING' && (
        <View style={styles.section}>
          <TouchableOpacity 
            style={styles.primaryButton}
            onPress={async () => {
              await updateOrderStatus(selectedOrder.id, 'EN_ROUTE');
            }}
          >
            <Text style={styles.primaryButtonText}>🚚 Start Delivery</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* STEP 2: Arrive at Destination (EN_ROUTE → ARRIVED) */}
      {selectedOrder.status?.toUpperCase() === 'EN_ROUTE' && (
        <View style={styles.section}>
          <TouchableOpacity 
            style={styles.arriveButton}
            onPress={async () => {
              await updateOrderStatus(selectedOrder.id, 'ARRIVED');
            }}
          >
            <Text style={styles.arriveButtonText}>📍 I Have Arrived</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* STEP 3: Payment Options (Only show when ARRIVED) */}
      {selectedOrder.status?.toUpperCase() === 'ARRIVED' && (
        <View style={styles.section}>
          {/* Generate QR Button */}
          {!qrValue && (
            <TouchableOpacity 
              style={[styles.primaryButton, loading && styles.buttonDisabled]}
              onPress={() => handleGenerateQR(selectedOrder)} 
              disabled={loading}
            >
              <Text style={styles.primaryButtonText}>
                {loading ? "Generating QR Code..." : "📱 Generate QR Code for Payment"}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Show QR Code when ARRIVED */}
      {qrValue && selectedOrder.status?.toUpperCase() === 'ARRIVED' && (
        <>
          <Text style={styles.qrTitle}>Scan QR Code</Text>
          
          {/* QR Expiry Timer */}
          {qrTimeRemaining !== null && qrTimeRemaining >= 0 && (
            <View style={styles.timerContainer}>
              <Text style={[
                styles.timerText,
                qrTimeRemaining <= 60 && styles.timerTextUrgent
              ]}>
                {qrTimeRemaining > 0 ? (
                  `QR expires in ${Math.floor(qrTimeRemaining / 60)}m ${qrTimeRemaining % 60}s`
                ) : (
                  '⏱️ EXPIRED - Regenerating...'
                )}
              </Text>
              <Text style={styles.timerSubtext}>
                Auto-refresh enabled
              </Text>
            </View>
          )}
          
          <View style={styles.qrContainer}>
            {!imageError ? (
              <Image 
                source={{ uri: qrValue }} 
                style={{ width: 250, height: 250 }}
                onError={(e) => {
                  console.error('Image load error:', e.nativeEvent.error);
                  setImageError(true);
                }}
                onLoad={() => console.log('QR image loaded successfully')}
              />
            ) : (
              <View>
                <Text style={{color: 'red', marginBottom: 10}}>Image failed to load</Text>
                <QRCode value={qrValue} size={250} />
              </View>
            )}
          </View>

          {/* Manual Refresh Button */}
          <TouchableOpacity
            style={[styles.refreshButton, loading && styles.buttonDisabled]}
            onPress={() => handleGenerateQR(selectedOrder, false)}
            disabled={loading}
          >
            <Text style={styles.refreshButtonText}>
              {loading ? '🔄 Generating...' : '🔄 Refresh QR Code'}
            </Text>
          </TouchableOpacity>
          
          {/* TEST MODE: Simulate payment confirmation */}
          <View style={styles.testModeBox}>
            <Text style={styles.testModeLabel}>
              TEST MODE: Simulate payment
            </Text>
            <TouchableOpacity
              style={styles.testButton}
              onPress={async () => {
                // Clear QR and mark as completed with QRPH payment
                setQrValue(null);
                setQrExpiresAt(null);
                setQrTimeRemaining(null);
                // Complete the order with proof
                handlePOD(selectedOrder.id, 'QRPH');
              }}
            >
              <Text style={styles.testButtonText}>✓ Simulate Payment Received</Text>
            </TouchableOpacity>
          </View>

          {/* Payment Failed - Switch to Cash */}
          <TouchableOpacity
            style={styles.failButton}
            onPress={() => {
              Alert.alert(
                "Payment Failed?",
                "Switch to cash payment instead?",
                [
                  { text: "Cancel", style: "cancel" },
                  { 
                    text: "Yes, Use Cash", 
                    style: "destructive",
                    onPress: () => {
                      setQrValue(null);
                      setQrExpiresAt(null);
                      setQrTimeRemaining(null);
                    }
                  }
                ]
              );
            }}
          >
            <Text style={styles.failButtonText}>Payment Failed? Switch to Cash</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Direct Cash Payment Option (Only when ARRIVED) */}
      {selectedOrder.status?.toUpperCase() === 'ARRIVED' && !qrValue && (
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.cashButton}
            onPress={() => {
              Alert.alert(
                "Cash Payment",
                "Why did the customer choose cash payment?",
                [
                  { text: "Cancel", style: "cancel" },
                  { 
                    text: "QR Payment Unavailable", 
                    onPress: () => handlePOD(selectedOrder.id, 'CASH', 'QR_PAYMENT_UNAVAILABLE')
                  },
                  { 
                    text: "Customer Request", 
                    onPress: () => handlePOD(selectedOrder.id, 'CASH', 'CUSTOMER_REQUEST')
                  }
                ]
              );
            }}
          >
            <Text style={styles.cashButtonText}>💵 Customer Paid Cash</Text>
          </TouchableOpacity>
        </View>
      )}

      {selectedOrder.status?.toUpperCase() === 'COMPLETED' && (
        <View style={styles.completedBox}>
          <Text style={styles.completedText}>✅ Delivery Completed</Text>
        </View>
      )}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, paddingTop: 50, backgroundColor: '#f5f5f5' },
  scrollView: { flex: 1, backgroundColor: '#f5f5f5' },
  scrollContent: { padding: 20, paddingTop: 50, paddingBottom: 40 },
  headerContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  header: { fontSize: 24, fontWeight: 'bold' },
  logoutButton: { backgroundColor: '#FF3B30', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  logoutText: { color: 'white', fontWeight: '600', fontSize: 14 },
  userEmail: { fontSize: 12, color: '#666', marginBottom: 15 },
  tabContainer: { 
    flexDirection: 'row', 
    marginBottom: 15, 
    borderBottomWidth: 1, 
    borderBottomColor: '#e0e0e0' 
  },
  tab: { 
    flex: 1, 
    paddingVertical: 12, 
    alignItems: 'center', 
    borderBottomWidth: 2, 
    borderBottomColor: 'transparent' 
  },
  activeTab: { 
    borderBottomColor: '#007AFF' 
  },
  tabText: { 
    fontSize: 16, 
    color: '#666', 
    fontWeight: '500' 
  },
  activeTabText: { 
    color: '#007AFF', 
    fontWeight: 'bold' 
  },
  card: { backgroundColor: 'white', padding: 20, borderRadius: 10, marginBottom: 12, elevation: 2, minHeight: 70 },
  cardDone: { opacity: 0.6 },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  orderNumber: { fontSize: 14, fontWeight: 'bold', color: '#333', flex: 1 },
  cardTitle: { fontSize: 18, fontWeight: 'bold' },
  amount: { fontSize: 18, color: '#2ecc71', fontWeight: 'bold', flex: 1, textAlign: 'center' },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12, minWidth: 80, alignItems: 'center' },
  statusText: { fontSize: 10, color: 'white', textTransform: 'uppercase', fontWeight: 'bold' },
  status: { fontSize: 11, color: '#666', textTransform: 'uppercase', fontWeight: '600' },
  detailBox: { backgroundColor: 'white', padding: 24, borderRadius: 16, marginVertical: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 3 },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  orderIdText: { fontSize: 16, fontWeight: 'bold', color: '#333' },
  infoSection: { marginBottom: 16 },
  infoRow: { flexDirection: 'row', gap: 16, marginBottom: 16 },
  infoColumn: { flex: 1 },
  detailLabel: { fontSize: 11, color: '#888', fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  detailValue: { fontSize: 18, fontWeight: '600', color: '#333' },
  detailAddress: { fontSize: 15, color: '#555', lineHeight: 22 },
  amountSection: { alignItems: 'center', paddingVertical: 12, backgroundColor: '#f8f9fa', borderRadius: 12, marginTop: 8 },
  amountLabel: { fontSize: 12, color: '#666', fontWeight: '600', textTransform: 'uppercase', marginBottom: 4 },
  amountLarge: { fontSize: 32, color: '#28a745', fontWeight: 'bold', letterSpacing: 1 },
  divider: { height: 1, backgroundColor: '#e0e0e0', width: '100%', marginVertical: 16 },
  backButton: { backgroundColor: '#007AFF', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, alignSelf: 'flex-start', marginBottom: 15 },
  backButtonText: { color: 'white', fontSize: 16, fontWeight: '600' },
  statusIndicator: { padding: 15, borderRadius: 10, marginVertical: 10, alignItems: 'center' },
  statusPending: { backgroundColor: '#fff3cd' },
  statusPaid: { backgroundColor: '#d4edda' },
  statusFailed: { backgroundColor: '#f8d7da' },
  statusIndicatorText: { fontSize: 16, fontWeight: 'bold' },
  primaryButton: { backgroundColor: '#007AFF', paddingVertical: 16, paddingHorizontal: 24, borderRadius: 10, width: '100%', alignItems: 'center' },
  primaryButtonText: { color: 'white', fontSize: 16, fontWeight: 'bold' },
  buttonDisabled: { opacity: 0.6 },
  cashButton: { backgroundColor: '#28a745', paddingVertical: 16, paddingHorizontal: 24, borderRadius: 10, width: '100%', alignItems: 'center', marginTop: 10 },
  cashButtonText: { color: 'white', fontSize: 16, fontWeight: 'bold' },
  failButton: { marginTop: 15, alignItems: 'center' },
  failButtonText: { color: '#dc3545', fontSize: 14, fontWeight: '600', textDecorationLine: 'underline' },
  section: { marginVertical: 10, width: '100%' },
  subHeader: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  qrTitle: { fontSize: 20, fontWeight: 'bold', color: '#333', textAlign: 'center', marginTop: 8, marginBottom: 10 },
  qrContainer: { alignItems: 'center', padding: 20, backgroundColor: 'white', borderRadius: 10 },
  qrInstruction: { marginTop: 15, fontSize: 16, fontWeight: '600', textAlign: 'center', color: '#333' },
  testModeBox: { marginTop: 20, padding: 15, backgroundColor: '#fff3cd', borderRadius: 8, width: '100%' },
  testModeLabel: { fontSize: 12, color: '#856404', marginBottom: 10, textAlign: 'center', fontWeight: '600' },
  testButton: { backgroundColor: '#28a745', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 8, alignItems: 'center' },
  testButtonText: { color: 'white', fontSize: 14, fontWeight: 'bold' },
  failedPaymentBox: { marginTop: 20, padding: 15, backgroundColor: '#f8d7da', borderRadius: 8, width: '100%', alignItems: 'center' },
  failedPaymentText: { fontSize: 14, color: '#721c24', fontWeight: '600', marginBottom: 10 },
  completedBox: { backgroundColor: '#d4edda', padding: 20, borderRadius: 10, marginTop: 20, alignItems: 'center' },
  completedText: { fontSize: 20, color: '#155724', fontWeight: 'bold' },
  stepTitle: { fontSize: 18, fontWeight: 'bold', color: '#333', marginBottom: 12, textAlign: 'center' },
  arriveButton: { backgroundColor: '#fd7e14', paddingVertical: 16, paddingHorizontal: 24, borderRadius: 10, width: '100%', alignItems: 'center', marginTop: 10 },
  arriveButtonText: { color: 'white', fontSize: 16, fontWeight: 'bold' },
  statusBadgeDetail: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 2, elevation: 2 },
  statusTextDetail: { fontSize: 11, color: 'white', textTransform: 'uppercase', fontWeight: 'bold', letterSpacing: 0.5 },
  loadingOverlay: { 
    position: 'absolute', 
    top: 0, 
    left: 0, 
    right: 0, 
    bottom: 0, 
    backgroundColor: 'rgba(0, 0, 0, 0.5)', 
    justifyContent: 'center', 
    alignItems: 'center', 
    zIndex: 9998 
  },
  loadingBox: { 
    backgroundColor: 'white', 
    padding: 30, 
    borderRadius: 16, 
    alignItems: 'center', 
    shadowColor: '#000', 
    shadowOffset: { width: 0, height: 4 }, 
    shadowOpacity: 0.3, 
    shadowRadius: 8, 
    elevation: 10 
  },
  loadingText: { 
    marginTop: 15, 
    fontSize: 16, 
    fontWeight: '600', 
    color: '#333' 
  },
  timerContainer: { 
    backgroundColor: '#007AFF', 
    paddingVertical: 12, 
    paddingHorizontal: 20, 
    borderRadius: 8, 
    marginBottom: 15, 
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3
  },
  timerText: { 
    fontSize: 18, 
    fontWeight: 'bold', 
    color: 'white',
    letterSpacing: 0.5,
    marginBottom: 4
  },
  timerTextUrgent: {
    color: '#FFD700'
  },
  timerSubtext: {
    fontSize: 11,
    color: 'rgba(255, 255, 255, 0.8)',
    fontWeight: '500'
  },
  refreshButton: {
    backgroundColor: '#6c757d',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    width: '100%',
    alignItems: 'center',
    marginTop: 15,
    marginBottom: 10
  },
  refreshButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600'
  }
});
