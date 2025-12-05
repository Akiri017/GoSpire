import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, FlatList, TouchableOpacity, Button, Alert, Image, ScrollView, ActivityIndicator } from 'react-native';
import { supabase } from '../../supabaseClient';
import QRCode from 'react-native-qrcode-svg';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '@/contexts/AuthContext';
import { captureCurrentLocation, formatCoordinates } from '@/services/locationService';

interface Order {
  id: string;
  customer_name: string;
  address: string;
  cod_amount: number;
  status: string;
  created_at: string;
  proof_url?: string;
  cash_fallback_reason?: string;
  fallback_timestamp?: string;
  payment_method?: string;
}

export default function HomeScreen() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const { user, signOut } = useAuth();

  // 1. Fetch Orders on Load
  useEffect(() => {
    // Only fetch orders if user is logged in
    if (user?.id) {
      fetchOrders();
    }

    // 2. Realtime Subscription: Listen for status changes (e.g., PAID)
    const subscription = supabase
      .channel('public:orders')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, 
      (payload: any) => {
        // If the updated order is the one we are looking at, update local state
        if (selectedOrder && payload.new.id === selectedOrder.id) {
          setSelectedOrder(payload.new);
          if (payload.new.status === 'PAID') {
            Alert.alert("Payment Received!", "The customer has paid via QRPH.");
          }
        }
        // Refresh the list regardless
        if (user?.id) {
          fetchOrders();
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(subscription); };
  }, [selectedOrder, user?.id]);

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
    }
  };

  // Update order status (for EN_ROUTE, ARRIVED)
  const updateOrderStatus = async (orderId: string, newStatus: string) => {
    const { error } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', orderId);
    
    if (error) {
      Alert.alert('Error', 'Failed to update status');
      return;
    }
    
    // Update local state
    if (selectedOrder) {
      const updatedOrder = { ...selectedOrder, status: newStatus };
      setSelectedOrder(updatedOrder);
    }
    fetchOrders();
  };

  // Handle cash fallback with reason
  const handleCashFallback = (orderId: string) => {
    Alert.alert(
      'Cash Payment - Select Reason',
      'Why did the customer pay with cash?',
      [
        {
          text: 'QR Payment Failed',
          onPress: () => processCashFallback(orderId, 'QR_PAYMENT_FAILED')
        },
        {
          text: 'Customer Has No Internet',
          onPress: () => processCashFallback(orderId, 'CUSTOMER_NO_INTERNET')
        },
        {
          text: 'Customer Prefers Cash',
          onPress: () => processCashFallback(orderId, 'CUSTOMER_REQUEST')
        },
        {
          text: 'App Error',
          onPress: () => processCashFallback(orderId, 'APP_ERROR')
        },
        { text: 'Cancel', style: 'cancel' }
      ]
    );
  };

  const processCashFallback = async (orderId: string, reason: string) => {
    const { error } = await supabase
      .from('orders')
      .update({ 
        status: 'PAID',
        payment_method: 'CASH',
        cash_fallback_reason: reason,
        fallback_timestamp: new Date().toISOString()
      })
      .eq('id', orderId);
    
    if (error) {
      Alert.alert('Error', 'Failed to record cash payment');
      return;
    }
    
    Alert.alert('Success', 'Cash payment recorded! Now take proof photo.');
    if (selectedOrder) {
      const updatedOrder = { ...selectedOrder, status: 'PAID', payment_method: 'CASH' };
      setSelectedOrder(updatedOrder);
    }
    fetchOrders();
  };

  // 3. Generate QR Code
  const handleGenerateQR = async (order: Order) => {
    setLoading(true);
    setImageError(false);
    try {
      console.log('Invoking generate-qr with:', { orderId: order.id, amount: order.cod_amount });
      
      // Try to call the Supabase function
      const { data, error } = await supabase.functions.invoke('generate-qr', {
        body: { orderId: order.id, amount: order.cod_amount }
      });

      console.log('Function response - data:', data);
      console.log('Function response - error:', error);

      // If function fails, use mock QR for testing UI
      if (error || !data || !data.qr_url) {
        console.warn('Edge function failed, using mock QR for testing');
        console.error('Error details:', error);
        
        // Generate a mock payment URL for testing
        // This creates a QR code with payment info that can be scanned
        const mockPaymentData = `payrex://pay?amount=${order.cod_amount}&order=${order.id}&merchant=RiderApp`;
        setQrValue(mockPaymentData);
        
        Alert.alert(
          "Mock QR Generated", 
          "Edge function not available. Using test QR code.\n\nTo fix: Deploy the Edge Function to Supabase and set PAYREX_SECRET_KEY."
        );
      } else {
        console.log('QR URL received:', data.qr_url);
        setQrValue(data.qr_url);
      }
      
      // Update status to PAYMENT_PENDING and payment_method to QRPH
      await supabase.from('orders').update({ 
        status: 'PAYMENT_PENDING',
        payment_method: 'QRPH'
      }).eq('id', order.id);
      
    } catch (err: any) {
      console.error('Generate QR error:', err);
      
      // Fallback to mock for testing
      const mockPaymentData = `payrex://pay?amount=${order.cod_amount}&order=${order.id}&merchant=RiderApp`;
      setQrValue(mockPaymentData);
      
      Alert.alert(
        "Using Test QR", 
        "Could not connect to payment service. Showing test QR code.\n\nError: " + (err.message || 'Unknown error')
      );
    } finally {
      setLoading(false);
    }
  };

  // 4. Proof of Delivery (Photo) + GPS Capture
  const handlePOD = async (orderId: string, paymentMethod: 'CASH' | 'QRPH' = 'CASH') => {
    try {
      // Step 1: Capture GPS coordinates first
      console.log('Capturing delivery location...');
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
        return;
      }

      const file = result.assets[0];
      const fileName = `${orderId}_${Date.now()}.jpg`;

      console.log('Uploading file:', fileName, 'from URI:', file.uri);

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
          
          // Complete order without proof URL but with GPS
          // Don't override payment_method - it's already set
          const { error: updateError } = await supabase
            .from('orders')
            .update({ 
              status: 'COMPLETED', 
              proof_url: 'no_storage_configured',
              delivery_latitude: location?.latitude,
              delivery_longitude: location?.longitude,
              delivery_timestamp: location?.timestamp.toISOString()
            })
            .eq('id', orderId);
          
          if (!updateError) {
            const paymentType = selectedOrder?.payment_method === 'CASH' ? 'Cash' : 'QRPH';
            const gpsMsg = location ? `\n📍 Location: ${formatCoordinates(location.latitude, location.longitude)}` : '';
            Alert.alert("Success", `Delivery marked as completed (${paymentType} - proof saved locally)${gpsMsg}`);
            setSelectedOrder(null);
            fetchOrders();
          }
          return;
        }
        
        Alert.alert("Upload Failed", error.message || 'Failed to upload image');
        return;
      }

      console.log('Upload successful:', data);

      // Get Public URL
      const { data: publicData } = supabase.storage.from('proofs').getPublicUrl(fileName);
      
      console.log('Public URL:', publicData.publicUrl);

      // Step 3: Update Order with proof URL, GPS coordinates (keep existing payment_method)
      // Don't override payment_method - it's already set (either CASH from fallback or QRPH from QR)
      const { error: updateError } = await supabase
        .from('orders')
        .update({ 
          status: 'COMPLETED', 
          proof_url: publicData.publicUrl,
          delivery_latitude: location?.latitude,
          delivery_longitude: location?.longitude,
          delivery_timestamp: location?.timestamp.toISOString()
        })
        .eq('id', orderId);
      
      if (updateError) {
        console.error('Update error:', updateError);
        Alert.alert("Update Failed", updateError.message);
        return;
      }
      
      // Get payment method for success message
      const paymentType = selectedOrder?.payment_method === 'CASH' ? 'Cash' : 'QRPH';
      const gpsMsg = location ? `\n📍 Location: ${formatCoordinates(location.latitude, location.longitude)}` : '';
      Alert.alert("Success", `Delivery Completed! (${paymentType} Payment)${gpsMsg}`);
      setSelectedOrder(null); // Go back to list
      fetchOrders();
    } catch (err: any) {
      console.error('POD error:', err);
      Alert.alert("Error", err.message || 'Failed to complete delivery');
    }
  };

  // --- RENDERING ---

  // Helper: Get status badge color
  const getStatusColor = (status: string) => {
    switch(status) {
      case 'PENDING': return '#95a5a6';
      case 'EN_ROUTE': return '#3498db';
      case 'ARRIVED': return '#9b59b6';
      case 'PAYMENT_PENDING': return '#f39c12';
      case 'PAID': return '#2ecc71';
      case 'COMPLETED': return '#27ae60';
      default: return '#7f8c8d';
    }
  };

  // Screen 1: The List
  if (!selectedOrder) {
    return (
      <View style={styles.container}>
        <View style={styles.headerContainer}>
          <Text style={styles.header}>My Deliveries</Text>
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
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity 
              style={[styles.card, item.status === 'COMPLETED' ? styles.cardDone : null]} 
              onPress={() => setSelectedOrder(item)}
            >
              <Text style={styles.cardTitle}>{item.customer_name}</Text>
              <Text>{item.address}</Text>
              <Text style={styles.amount}>₱{item.cod_amount}</Text>
              <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) }]}>
                <Text style={styles.statusText}>{item.status}</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      </View>
    );
  }

  // Screen 2: Detail & Actions
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Button title="< Back" onPress={() => { setSelectedOrder(null); setQrValue(null); setImageError(false); }} />
      
      <View style={styles.detailBox}>
        <Text style={styles.cardTitle}>{selectedOrder.customer_name}</Text>
        <Text style={styles.amount}>₱{selectedOrder.cod_amount}</Text>
        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(selectedOrder.status), marginTop: 10 }]}>
          <Text style={styles.statusText}>{selectedOrder.status}</Text>
        </View>
        {selectedOrder.cash_fallback_reason && (
          <Text style={{marginTop: 10, fontSize: 12, color: '#e74c3c', fontStyle: 'italic'}}>
            💵 Cash Fallback: {selectedOrder.cash_fallback_reason.replace(/_/g, ' ')}
          </Text>
        )}
      </View>

      {/* STEP 1: Start Delivery (PENDING → EN_ROUTE) */}
      {selectedOrder.status === 'PENDING' && (
        <View style={styles.section}>
          <Text style={styles.subHeader}>📦 Ready to Start?</Text>
          <Button 
            title="🚗 Start Delivery (Leave Hub)" 
            onPress={() => updateOrderStatus(selectedOrder.id, 'EN_ROUTE')} 
            color="#3498db"
          />
        </View>
      )}

      {/* STEP 2: Mark Arrived (EN_ROUTE → ARRIVED) */}
      {selectedOrder.status === 'EN_ROUTE' && (
        <View style={styles.section}>
          <Text style={styles.subHeader}>🚗 On the Way...</Text>
          <Button 
            title="📍 Mark as Arrived" 
            onPress={() => updateOrderStatus(selectedOrder.id, 'ARRIVED')} 
            color="#9b59b6"
          />
        </View>
      )}

      {/* STEP 3: Payment Options (ARRIVED → PAYMENT_PENDING or PAID) */}
      {selectedOrder.status === 'ARRIVED' && (
        <View>
          <View style={styles.section}>
            <Text style={styles.subHeader}>💰 Collect Payment</Text>
            <Button 
              title={loading ? "Generating QR..." : "📱 Generate QRPH Code"} 
              onPress={() => handleGenerateQR(selectedOrder)} 
              disabled={loading}
              color="#f39c12"
            />
            {qrValue && (
              <View style={styles.qrContainer}>
                 {!imageError ? (
                   <Image 
                     source={{ uri: qrValue }} 
                     style={{ width: 250, height: 250, marginVertical: 20 }}
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
                 <Text style={{marginTop: 10, fontSize: 16, fontWeight: 'bold'}}>Ask Customer to Scan</Text>
              </View>
            )}
          </View>
          
          <View style={{marginTop: 20}}>
            <Text style={{textAlign: 'center', marginBottom: 10, color: '#7f8c8d'}}>— OR —</Text>
            <Button 
              title="💵 Accept Cash (Fallback)" 
              onPress={() => handleCashFallback(selectedOrder.id)} 
              color="#27ae60"
            />
          </View>
        </View>
      )}

      {/* STEP 3b: Waiting for QR Payment */}
      {selectedOrder.status === 'PAYMENT_PENDING' && (
        <View>
          <View style={styles.section}>
            <Text style={styles.subHeader}>⏳ Waiting for Payment...</Text>
            {qrValue && (
              <View style={styles.qrContainer}>
                 {!imageError ? (
                   <Image 
                     source={{ uri: qrValue }} 
                     style={{ width: 250, height: 250, marginVertical: 20 }}
                     onError={(e) => {
                       console.error('Image load error:', e.nativeEvent.error);
                       setImageError(true);
                     }}
                   />
                 ) : (
                   <View>
                     <Text style={{color: 'red', marginBottom: 10}}>Image failed to load</Text>
                     <QRCode value={qrValue} size={250} />
                   </View>
                 )}
                 <Text style={{marginTop: 10, fontSize: 16, fontWeight: 'bold'}}>Customer Scanning...</Text>
                 
                 {/* TEST MODE: Simulate payment */}
                 <View style={{marginTop: 20, padding: 10, backgroundColor: '#fff3cd', borderRadius: 5}}>
                   <Text style={{fontSize: 12, color: '#856404', marginBottom: 10, textAlign: 'center'}}>
                     TEST MODE: Simulate payment without scanning
                   </Text>
                   <Button 
                     title="✓ Simulate Payment Received" 
                     color="#28a745"
                     onPress={async () => {
                       await supabase.from('orders').update({ status: 'PAID' }).eq('id', selectedOrder.id);
                       Alert.alert("Test Payment", "Order marked as PAID for testing");
                     }}
                   />
                 </View>
              </View>
            )}
          </View>
          
          <View style={{marginTop: 20}}>
            <Text style={{textAlign: 'center', marginBottom: 10, color: '#e74c3c', fontWeight: 'bold'}}>Payment Failed?</Text>
            <Button 
              title="💵 Switch to Cash" 
              onPress={() => handleCashFallback(selectedOrder.id)} 
              color="#e74c3c"
            />
          </View>
        </View>
      )}

      {/* STEP 4: Proof of Delivery (PAID → COMPLETED) */}
      {selectedOrder.status === 'PAID' && (
        <View style={styles.section}>
          <Text style={{color: 'green', fontSize: 18, fontWeight: 'bold', marginBottom: 10}}>
             ✅ PAYMENT CONFIRMED!
          </Text>
          <Text style={{fontSize: 14, color: '#666', marginBottom: 10}}>
            Payment Method: {selectedOrder.payment_method || 'Unknown'}
          </Text>
          <Button 
            title="📸 Take Proof Photo & Complete" 
            onPress={() => handlePOD(selectedOrder.id)} 
            color="#27ae60"
          />
        </View>
      )}

      {/* COMPLETED */}
      {selectedOrder.status === 'COMPLETED' && (
        <Text style={{fontSize: 20, color: 'green', marginTop: 20, textAlign: 'center'}}>
          ✅ Delivery Completed!
        </Text>
      )}

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, paddingTop: 50, backgroundColor: '#f5f5f5' },
  headerContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  header: { fontSize: 24, fontWeight: 'bold' },
  logoutButton: { backgroundColor: '#FF3B30', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  logoutText: { color: 'white', fontWeight: '600', fontSize: 14 },
  userEmail: { fontSize: 12, color: '#666', marginBottom: 15 },
  card: { backgroundColor: 'white', padding: 15, borderRadius: 10, marginBottom: 10, elevation: 2 },
  cardDone: { opacity: 0.6 },
  cardTitle: { fontSize: 18, fontWeight: 'bold' },
  amount: { fontSize: 18, color: '#2ecc71', fontWeight: 'bold', marginTop: 5 },
  status: { fontSize: 12, color: 'gray', marginTop: 5, textTransform: 'uppercase' },
  statusBadge: { 
    paddingHorizontal: 12, 
    paddingVertical: 6, 
    borderRadius: 15, 
    marginTop: 8,
    alignSelf: 'flex-start'
  },
  statusText: { 
    color: 'white', 
    fontSize: 11, 
    fontWeight: 'bold', 
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  detailBox: { backgroundColor: 'white', padding: 20, borderRadius: 10, marginVertical: 20, alignItems: 'center' },
  section: { marginVertical: 10, alignItems: 'center' },
  subHeader: { fontSize: 16, fontWeight: '600', marginBottom: 15, textAlign: 'center' },
  qrContainer: { alignItems: 'center', marginTop: 20, padding: 20, backgroundColor: 'white', borderRadius: 10 },
});
