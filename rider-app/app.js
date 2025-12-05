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
              <Text style={styles.status}>{item.status}</Text>
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
        <Text>Status: {selectedOrder.status}</Text>
      </View>

      {/* ACTION: Pay via QR */}
      {selectedOrder.status !== 'COMPLETED' && selectedOrder.status !== 'PAID' && (
        <View style={styles.section}>
          <Text style={styles.subHeader}>Payment Method</Text>
          <Button 
            title={loading ? "Generating..." : "Generate QRPH Code"} 
            onPress={() => handleGenerateQR(selectedOrder)} 
            disabled={loading}
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
      )}

      {/* ACTION: Pay via Cash (Fallback) */}
      {selectedOrder.status !== 'COMPLETED' && selectedOrder.status !== 'PAID' && (
        <View style={{marginTop: 10}}>
           <Button title="Customer Paid Cash" color="green" onPress={() => handlePOD(selectedOrder.id)} />
        </View>
      )}

      {/* ACTION: Proof of Delivery (After QR Payment) */}
      {selectedOrder.status === 'PAID' && (
        <View style={styles.section}>
          <Text style={{color: 'green', fontSize: 18, fontWeight: 'bold', marginBottom: 10}}>
             PAYMENT CONFIRMED!
          </Text>
          <Button title="Take Proof Photo & Finish" onPress={() => handlePOD(selectedOrder.id)} />
        </View>
      )}

      {selectedOrder.status === 'COMPLETED' && (
        <Text style={{fontSize: 20, color: 'green', marginTop: 20, textAlign: 'center'}}>
          Delivery Completed ✅
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
  detailBox: { backgroundColor: 'white', padding: 20, borderRadius: 10, marginVertical: 20, alignItems: 'center' },
  section: { marginVertical: 10, alignItems: 'center' },
  qrContainer: { alignItems: 'center', marginTop: 20, padding: 20, backgroundColor: 'white' },
});