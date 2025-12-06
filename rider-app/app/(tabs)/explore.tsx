import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, ScrollView, TouchableOpacity, Linking, Alert, RefreshControl } from 'react-native';
import { supabase } from '../../supabaseClient';
import { useAuth } from '@/contexts/AuthContext';
import { getGoogleMapsLink, formatCoordinates } from '@/services/locationService';

interface OrderWithLocation {
  id: string;
  customer_name: string;
  address: string;
  cod_amount: number;
  status: string;
  payment_method: string | null;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  delivery_timestamp: string | null;
  created_at: string;
}

export default function ExploreScreen() {
  const [completedOrders, setCompletedOrders] = useState<OrderWithLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (user?.id) {
      fetchCompletedOrdersWithLocation();
    }

    // Set up real-time subscription to listen for completed orders
    const subscription = supabase
      .channel('public:orders:explore')
      .on('postgres_changes', { 
        event: '*', 
        schema: 'public', 
        table: 'orders',
        filter: `rider_id=eq.${user?.id}`
      }, 
      (payload: any) => {
        console.log('Order updated in Map tab:', payload);
        // Refresh the list when any order changes
        if (user?.id) {
          fetchCompletedOrdersWithLocation();
        }
      })
      .subscribe();

    return () => { 
      supabase.removeChannel(subscription); 
    };
  }, [user?.id]);

  const fetchCompletedOrdersWithLocation = async (isRefreshing = false) => {
    if (!user?.id) return;

    if (isRefreshing) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    
    try {
      // Fetch completed orders that have GPS coordinates
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('rider_id', user.id)
        .eq('status', 'COMPLETED')
        .not('delivery_latitude', 'is', null)
        .not('delivery_longitude', 'is', null)
        .order('delivery_timestamp', { ascending: false });

      if (error) {
        console.error('Error fetching orders with location:', error);
        if (!isRefreshing) {
          Alert.alert('Error', 'Failed to load delivery locations');
        }
      } else {
        setCompletedOrders(data || []);
      }
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    fetchCompletedOrdersWithLocation(true);
  };

  const openInMaps = (latitude: number, longitude: number, customerName: string) => {
    const mapsUrl = getGoogleMapsLink(latitude, longitude);
    Linking.openURL(mapsUrl).catch(() => {
      Alert.alert('Error', 'Could not open maps');
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return '#10b981';
      case 'PAID': return '#3b82f6';
      default: return '#6b7280';
    }
  };

  if (!user) {
    return (
      <View style={styles.container}>
        <Text style={styles.emptyText}>Please log in to view delivery locations</Text>
      </View>
    );
  }

  return (
    <ScrollView 
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#10b981"
          colors={["#10b981"]}
        />
      }
    >
      <View style={styles.header}>
        <Text style={styles.title}>📍 Delivery Locations</Text>
        <Text style={styles.subtitle}>
          {completedOrders.length} completed deliveries with GPS data
        </Text>
      </View>

      {loading ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>Loading...</Text>
        </View>
      ) : completedOrders.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No completed deliveries with location data yet</Text>
          <Text style={styles.emptySubtext}>
            Complete a delivery to see it here!
          </Text>
        </View>
      ) : (
        <View style={styles.listContainer}>
          {completedOrders.map((order) => (
            <View key={order.id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.orderIdText}>Order #{order.id.slice(0, 8)}</Text>
                <View style={[styles.statusBadge, { backgroundColor: getStatusColor(order.status) }]}>
                  <Text style={styles.statusText}>{order.status}</Text>
                </View>
              </View>

              <View style={styles.infoRow}>
                <Text style={styles.label}>📍 Address:</Text>
                <Text style={styles.value}>{order.address}</Text>
              </View>

              {order.delivery_latitude && order.delivery_longitude && (
                <TouchableOpacity
                  style={styles.mapButton}
                  onPress={() => openInMaps(
                    order.delivery_latitude!,
                    order.delivery_longitude!,
                    order.customer_name
                  )}
                >
                  <Text style={styles.mapButtonText}>🗺️ View on Map</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>
      )}

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          💡 Tip: GPS coordinates are captured when you complete a delivery
        </Text>
        <Text style={styles.footerText}>
          🔄 Pull down to refresh
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    padding: 20,
    paddingTop: 60,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1f2937',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#6b7280',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    minHeight: 300,
  },
  emptyText: {
    fontSize: 16,
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#9ca3af',
    textAlign: 'center',
  },
  listContainer: {
    padding: 16,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  orderIdText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1f2937',
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  statusText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  infoRow: {
    marginBottom: 8,
  },
  label: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '600',
    marginBottom: 2,
  },
  value: {
    fontSize: 14,
    color: '#1f2937',
  },
  paymentValue: {
    fontSize: 14,
    color: '#059669',
    fontWeight: '600',
  },
  mapButton: {
    backgroundColor: '#10b981',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  mapButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  footer: {
    padding: 20,
    alignItems: 'center',
  },
  footerText: {
    fontSize: 12,
    color: '#6b7280',
    textAlign: 'center',
  },
});
