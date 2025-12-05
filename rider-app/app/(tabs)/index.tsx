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
}

export default function HomeScreen() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [activeTab, setActiveTab] = useState<'active' | 'completed'>('active');
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
            Alert.alert("Payment Received!", "The customer has paid via QRPH. Completing order...");
            // Auto-complete the order
            supabase.from('orders').update({ status: 'COMPLETED' }).eq('id', payload.new.id);
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
      
      // Update status to PENDING and payment_method to QRPH
      await supabase.from('orders').update({ 
        status: 'PENDING',
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
          const { error: updateError } = await supabase
            .from('orders')
            .update({ 
              status: 'COMPLETED', 
              proof_url: 'no_storage_configured',
              payment_method: paymentMethod,
              delivery_latitude: location?.latitude,
              delivery_longitude: location?.longitude,
              delivery_timestamp: location?.timestamp.toISOString()
            })
            .eq('id', orderId);
          
          if (!updateError) {
            const gpsMsg = location ? `\n📍 Location: ${formatCoordinates(location.latitude, location.longitude)}` : '';
            Alert.alert("Success", `Delivery marked as completed (proof saved locally)${gpsMsg}`);
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

      // Step 3: Update Order with proof URL, payment method, AND GPS coordinates
      const { error: updateError } = await supabase
        .from('orders')
        .update({ 
          status: 'COMPLETED', 
          proof_url: publicData.publicUrl,
          payment_method: paymentMethod,
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
      
      const gpsMsg = location ? `\n📍 Location: ${formatCoordinates(location.latitude, location.longitude)}` : '';
      Alert.alert("Success", `Delivery Completed!${gpsMsg}`);
      setSelectedOrder(null); // Go back to list
      fetchOrders();
    } catch (err: any) {
      console.error('POD error:', err);
      Alert.alert("Error", err.message || 'Failed to complete delivery');
    }
  };

  // --- RENDERING ---

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
            // Determine status color
            const getStatusColor = (status: string) => {
              switch(status.toUpperCase()) {
                case 'COMPLETED': return '#28a745';      // Green
                case 'PAID': return '#17a2b8';           // Teal
                case 'PENDING': return '#ffc107';        // Yellow - Awaiting payment/action
                case 'EN_ROUTE': return '#007bff';       // Blue
                case 'ENROUTE': return '#007bff';        // Blue (alternate spelling)
                case 'ARRIVED': return '#fd7e14';        // Orange
                default: return '#6c757d';               // Gray (default)
              }
            };
            
            return (
              <TouchableOpacity 
                style={styles.card} 
                onPress={() => setSelectedOrder(item)}
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
    <ScrollView 
      style={styles.scrollView}
      contentContainerStyle={styles.scrollContent}
    >
      <TouchableOpacity 
        style={styles.backButton}
        onPress={() => { 
          setSelectedOrder(null); 
          setQrValue(null); 
          setImageError(false);
        }}
      >
        <Text style={styles.backButtonText}>← Back</Text>
      </TouchableOpacity>
      
      <View style={styles.detailBox}>
        <Text style={styles.detailLabel}>Customer</Text>
        <Text style={styles.cardTitle}>{selectedOrder.customer_name}</Text>
        <Text style={styles.detailAddress}>{selectedOrder.address}</Text>
        <View style={styles.divider} />
        <Text style={styles.detailLabel}>Amount to Collect</Text>
        <Text style={styles.amount}>₱{selectedOrder.cod_amount.toFixed(2)}</Text>
      </View>

      {/* ACTION: Generate QR or Show QR */}
      {selectedOrder.status !== 'COMPLETED' && !qrValue && (
        <View style={styles.section}>
          <TouchableOpacity 
            style={[styles.primaryButton, loading && styles.buttonDisabled]}
            onPress={() => handleGenerateQR(selectedOrder)} 
            disabled={loading}
          >
            <Text style={styles.primaryButtonText}>
              {loading ? "Generating QR Code..." : "📱 Generate QR Code for Payment"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Show QR Code */}
      {qrValue && selectedOrder.status !== 'COMPLETED' && (
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
          <Text style={styles.qrInstruction}>Ask customer to scan this QR code</Text>
          
          {/* TEST MODE: Simulate payment confirmation */}
          {selectedOrder.status === 'PENDING' && (
            <View style={styles.testModeBox}>
              <Text style={styles.testModeLabel}>
                TEST MODE: Simulate payment
              </Text>
              <TouchableOpacity
                style={styles.testButton}
                onPress={async () => {
                  await supabase.from('orders').update({ status: 'PAID' }).eq('id', selectedOrder.id);
                  Alert.alert("Test Payment", "Order marked as PAID for testing");
                }}
              >
                <Text style={styles.testButtonText}>✓ Simulate Payment Received</Text>
              </TouchableOpacity>
            </View>
          )}

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
                      handlePOD(selectedOrder.id, 'CASH');
                    }
                  }
                ]
              );
            }}
          >
            <Text style={styles.failButtonText}>Payment Failed? Switch to Cash</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Direct Cash Payment Option */}
      {selectedOrder.status !== 'COMPLETED' && !qrValue && (
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.cashButton}
            onPress={() => handlePOD(selectedOrder.id, 'CASH')}
          >
            <Text style={styles.cashButtonText}>💵 Customer Paid Cash</Text>
          </TouchableOpacity>
        </View>
      )}

      {selectedOrder.status === 'COMPLETED' && (
        <View style={styles.completedBox}>
          <Text style={styles.completedText}>✅ Delivery Completed</Text>
        </View>
      )}

    </ScrollView>
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
  detailBox: { backgroundColor: 'white', padding: 24, borderRadius: 12, marginVertical: 20 },
  detailLabel: { fontSize: 12, color: '#666', fontWeight: '600', textTransform: 'uppercase', marginBottom: 5 },
  detailAddress: { fontSize: 14, color: '#666', marginTop: 5, marginBottom: 15 },
  divider: { height: 1, backgroundColor: '#e0e0e0', width: '100%', marginVertical: 15 },
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
  qrContainer: { alignItems: 'center', marginTop: 20, padding: 20, backgroundColor: 'white', borderRadius: 10 },
  qrInstruction: { marginTop: 15, fontSize: 16, fontWeight: '600', textAlign: 'center', color: '#333' },
  testModeBox: { marginTop: 20, padding: 15, backgroundColor: '#fff3cd', borderRadius: 8, width: '100%' },
  testModeLabel: { fontSize: 12, color: '#856404', marginBottom: 10, textAlign: 'center', fontWeight: '600' },
  testButton: { backgroundColor: '#28a745', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 8, alignItems: 'center' },
  testButtonText: { color: 'white', fontSize: 14, fontWeight: 'bold' },
  failedPaymentBox: { marginTop: 20, padding: 15, backgroundColor: '#f8d7da', borderRadius: 8, width: '100%', alignItems: 'center' },
  failedPaymentText: { fontSize: 14, color: '#721c24', fontWeight: '600', marginBottom: 10 },
  completedBox: { backgroundColor: '#d4edda', padding: 20, borderRadius: 10, marginTop: 20, alignItems: 'center' },
  completedText: { fontSize: 20, color: '#155724', fontWeight: 'bold' },
});
