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
            // Clear QR code since payment is received
            setQrValue(null);
            // Auto-complete the order
            supabase.from('orders').update({ status: 'COMPLETED' }).eq('id', payload.new.id);
          }
          // If order is completed, clear QR and show completed state
          if (payload.new.status === 'COMPLETED') {
            setQrValue(null);
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

  // 3. Update Order Status
  const updateOrderStatus = async (orderId: string, newStatus: string) => {
    const { error } = await supabase
      .from('orders')
      .update({ status: newStatus })
      .eq('id', orderId);
    
    if (error) {
      console.error('Error updating status:', error);
      Alert.alert('Error', 'Failed to update order status');
      return false;
    }
    
    // Update local state
    setSelectedOrder(prev => prev ? { ...prev, status: newStatus } : null);
    fetchOrders();
    return true;
  };

  // 4. Generate QR Code
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
      
      // Update payment_method to QRPH (status remains ARRIVED)
      await supabase.from('orders').update({ 
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

  // 5. Proof of Delivery (Photo) + GPS Capture
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
                    }
                  }
                ]
              );
            }}
          >
            <Text style={styles.failButtonText}>Payment Failed? Switch to Cash</Text>
          </TouchableOpacity>
        </View>
        </>
      )}

      {/* Direct Cash Payment Option (Only when ARRIVED) */}
      {selectedOrder.status?.toUpperCase() === 'ARRIVED' && !qrValue && (
        <View style={styles.section}>
          <TouchableOpacity
            style={styles.cashButton}
            onPress={() => handlePOD(selectedOrder.id, 'CASH')}
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
});
