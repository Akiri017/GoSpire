import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, FlatList, TouchableOpacity, Button, Alert, Image, ScrollView, ActivityIndicator } from 'react-native';
import { supabase } from './supabaseClient';
import QRCode from 'react-native-qrcode-svg';
import * as ImagePicker from 'expo-image-picker';

export default function App() {
  const [orders, setOrders] = useState([]);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [qrValue, setQrValue] = useState(null);
  const [loading, setLoading] = useState(false);
  const [imageError, setImageError] = useState(false);

  // 1. Fetch Orders on Load
  useEffect(() => {
    fetchOrders();

    // 2. Realtime Subscription: Listen for status changes (e.g., PAID)
    const subscription = supabase
      .channel('public:orders')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, 
      (payload) => {
        // If the updated order is the one we are looking at, update local state
        if (selectedOrder && payload.new.id === selectedOrder.id) {
          setSelectedOrder(payload.new);
          if (payload.new.status === 'PAID') {
            Alert.alert("Payment Received!", "The customer has paid via QRPH.");
          }
        }
        // Refresh the list regardless
        fetchOrders();
      })
      .subscribe();

    return () => supabase.removeChannel(subscription);
  }, [selectedOrder]);

  const fetchOrders = async () => {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error) setOrders(data);
  };

  // Update order status (for EN_ROUTE, ARRIVED)
  const updateOrderStatus = async (orderId, newStatus) => {
    const { error } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', orderId);
    
    if (error) {
      Alert.alert('Error', 'Failed to update status');
      return;
    }
    
    // Update local state
    const updatedOrder = { ...selectedOrder, status: newStatus };
    setSelectedOrder(updatedOrder);
    fetchOrders();
  };

  // Handle cash fallback with reason
  const handleCashFallback = (orderId) => {
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

  const processCashFallback = async (orderId, reason) => {
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
    const updatedOrder = { ...selectedOrder, status: 'PAID', payment_method: 'CASH' };
    setSelectedOrder(updatedOrder);
    fetchOrders();
  };

  // 3. Generate QR Code
  const handleGenerateQR = async (order) => {
    setLoading(true);
    setImageError(false);
    try {
      const { data, error } = await supabase.functions.invoke('generate-qr', {
        body: { orderId: order.id, amount: order.cod_amount }
      });

      if (error) {
        console.error('Supabase function error:', error);
        throw error;
      }
      
      if (!data || !data.qr_url) {
        throw new Error('No QR code URL received from server');
      }
      
      console.log('QR URL received:', data.qr_url);
      setQrValue(data.qr_url); 
      
      // Update status to PAYMENT_PENDING locally
      await supabase.from('orders').update({ status: 'PAYMENT_PENDING' }).eq('id', order.id);
      
    } catch (err) {
      console.error('Generate QR error:', err);
      Alert.alert("Error", err.message || 'Failed to generate QR code');
    } finally {
      setLoading(false);
    }
  };

  // 4. Proof of Delivery (Photo)
  const handlePOD = async (orderId) => {
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.5,
      base64: true, // simplified upload for MVP
    });

    if (!result.canceled) {
      const file = result.assets[0];
      const fileName = `${orderId}_${Date.now()}.jpg`;

      // Upload to Supabase Storage
      const { data, error } = await supabase.storage
        .from('proofs')
        .upload(fileName, { uri: file.uri, type: 'image/jpeg', name: fileName });

      if (error) {
        Alert.alert("Upload Failed", error.message);
        return;
      }

      // Get Public URL
      const { data: publicData } = supabase.storage.from('proofs').getPublicUrl(fileName);

      // Update Order
      await supabase
        .from('orders')
        .update({ status: 'COMPLETED', proof_url: publicData.publicUrl })
        .eq('id', orderId);
        
      Alert.alert("Success", "Delivery Completed!");
      setSelectedOrder(null); // Go back to list
      fetchOrders();
    }
  };

  // --- RENDERING ---

  // Helper: Get status badge color
  const getStatusColor = (status) => {
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
        <Text style={styles.header}>My Deliveries</Text>
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
  header: { fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
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