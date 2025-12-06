import React, { useState, useEffect } from 'react';
import { StyleSheet, View, Text, ScrollView, RefreshControl, TouchableOpacity, Alert } from 'react-native';
import { supabase } from '../../supabaseClient';
import { useAuth } from '@/contexts/AuthContext';

interface DailyStats {
  totalDeliveries: number;
  qrphCount: number;
  qrphAmount: number;
  cashCount: number;
  cashAmount: number;
  totalAmount: number;
}

export default function SettlementScreen() {
  const [dailyStats, setDailyStats] = useState<DailyStats>({
    totalDeliveries: 0,
    qrphCount: 0,
    qrphAmount: 0,
    cashCount: 0,
    cashAmount: 0,
    totalAmount: 0
  });
  const [refreshing, setRefreshing] = useState(false);
  const { user, signOut } = useAuth();

  useEffect(() => {
    if (user?.id) {
      fetchDailyStats();
    }

    // Set up real-time subscription
    const subscription = supabase
      .channel('public:orders:settlement')
      .on('postgres_changes', { 
        event: '*', 
        schema: 'public', 
        table: 'orders',
        filter: `rider_id=eq.${user?.id}`
      }, 
      (payload: any) => {
        console.log('Order updated in Settlement tab:', payload);
        if (user?.id) {
          fetchDailyStats();
        }
      })
      .subscribe();

    return () => { 
      supabase.removeChannel(subscription); 
    };
  }, [user?.id]);

  const fetchDailyStats = async (isRefreshing = false) => {
    if (!user?.id) return;

    if (isRefreshing) {
      setRefreshing(true);
    }
    
    try {
      // Get today's date range (start of day to now)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayStart = today.toISOString();

      // Fetch completed orders for today
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .eq('rider_id', user.id)
        .eq('status', 'COMPLETED')
        .gte('created_at', todayStart);

      if (error) {
        console.error('Error fetching daily stats:', error);
        if (!isRefreshing) {
          Alert.alert('Error', 'Failed to load daily statistics');
        }
      } else {
        // Calculate statistics
        const stats: DailyStats = {
          totalDeliveries: data.length,
          qrphCount: 0,
          qrphAmount: 0,
          cashCount: 0,
          cashAmount: 0,
          totalAmount: 0
        };

        data.forEach(order => {
          const amount = order.cod_amount || 0;
          stats.totalAmount += amount;

          if (order.payment_method === 'QRPH') {
            stats.qrphCount++;
            stats.qrphAmount += amount;
          } else if (order.payment_method === 'CASH') {
            stats.cashCount++;
            stats.cashAmount += amount;
          }
        });

        setDailyStats(stats);
      }
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const onRefresh = () => {
    fetchDailyStats(true);
  };

  // Get greeting based on time of day
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  // Get rider name from email
  const getRiderName = () => {
    if (!user?.email) return 'Rider';
    const name = user.email.split('@')[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  };

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* Header */}
        <View style={styles.headerContainer}>
          <View>
            <Text style={styles.header}>{getGreeting()}, {getRiderName()}!</Text>
            <Text style={styles.subHeader}>Daily Settlement Summary</Text>
          </View>
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

        {/* Today's Date */}
        <View style={styles.dateContainer}>
          <Text style={styles.dateText}>
            📅 {new Date().toLocaleDateString('en-US', { 
              weekday: 'long', 
              year: 'numeric', 
              month: 'long', 
              day: 'numeric' 
            })}
          </Text>
        </View>

        {/* Total Deliveries Card */}
        <View style={styles.summaryCard}>
          <Text style={styles.cardTitle}>Total Deliveries Today</Text>
          <Text style={styles.cardValueLarge}>{dailyStats.totalDeliveries}</Text>
          <View style={styles.divider} />
          <Text style={styles.totalAmountLabel}>Total Amount Collected</Text>
          <Text style={styles.totalAmountValue}>₱{dailyStats.totalAmount.toFixed(2)}</Text>
        </View>

        {/* Payment Method Split */}
        <View style={styles.splitContainer}>
          {/* QRPH Card */}
          <View style={[styles.paymentCard, styles.qrphCard]}>
            <Text style={styles.paymentIcon}>📱</Text>
            <Text style={styles.paymentLabel}>QR Payment</Text>
            <Text style={styles.paymentCount}>{dailyStats.qrphCount} orders</Text>
            <View style={styles.amountContainer}>
              <Text style={styles.paymentAmount}>₱{dailyStats.qrphAmount.toFixed(2)}</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>SETTLED</Text>
            </View>
          </View>

          {/* Cash Card */}
          <View style={[styles.paymentCard, styles.cashCard]}>
            <Text style={styles.paymentIcon}>💵</Text>
            <Text style={styles.paymentLabel}>Cash Payment</Text>
            <Text style={styles.paymentCount}>{dailyStats.cashCount} orders</Text>
            <View style={styles.amountContainer}>
              <Text style={styles.paymentAmount}>₱{dailyStats.cashAmount.toFixed(2)}</Text>
            </View>
            <View style={styles.badgeWarning}>
              <Text style={styles.badgeText}>TO REMIT</Text>
            </View>
          </View>
        </View>

        {/* Settlement Ready */}
        <View style={styles.settlementCard}>
          <Text style={styles.settlementTitle}>💰 Settlement Summary</Text>
          <View style={styles.settlementRow}>
            <Text style={styles.settlementLabel}>Digital Payments (Auto-settled):</Text>
            <Text style={styles.settlementValueGreen}>₱{dailyStats.qrphAmount.toFixed(2)}</Text>
          </View>
          <View style={styles.settlementRow}>
            <Text style={styles.settlementLabel}>Cash to Remit:</Text>
            <Text style={styles.settlementValueOrange}>₱{dailyStats.cashAmount.toFixed(2)}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.settlementRow}>
            <Text style={styles.settlementLabelBold}>Net Settlement:</Text>
            <Text style={styles.settlementValueBold}>₱{dailyStats.totalAmount.toFixed(2)}</Text>
          </View>
        </View>

        {/* Info Box */}
        <View style={styles.infoBox}>
          <Text style={styles.infoIcon}>ℹ️</Text>
          <View style={styles.infoTextContainer}>
            <Text style={styles.infoTitle}>Settlement Notes:</Text>
            <Text style={styles.infoText}>• QR payments are automatically settled to your account</Text>
            <Text style={styles.infoText}>• Cash payments must be remitted at end of shift</Text>
            <Text style={styles.infoText}>• Stats reset daily at midnight</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: '#f5f5f5' 
  },
  scrollContent: { 
    padding: 20, 
    paddingTop: 50,
    paddingBottom: 40 
  },
  headerContainer: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'flex-start',
    marginBottom: 10 
  },
  header: { 
    fontSize: 24, 
    fontWeight: 'bold',
    color: '#333'
  },
  subHeader: {
    fontSize: 14,
    color: '#666',
    marginTop: 4
  },
  logoutButton: { 
    backgroundColor: '#FF3B30', 
    paddingHorizontal: 16, 
    paddingVertical: 8, 
    borderRadius: 8 
  },
  logoutText: { 
    color: 'white', 
    fontWeight: '600', 
    fontSize: 14 
  },
  userEmail: { 
    fontSize: 12, 
    color: '#666', 
    marginBottom: 15 
  },
  dateContainer: {
    backgroundColor: 'white',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2
  },
  dateText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333'
  },
  summaryCard: {
    backgroundColor: 'white',
    padding: 24,
    borderRadius: 16,
    marginBottom: 20,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3
  },
  cardTitle: {
    fontSize: 16,
    color: '#666',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
    textAlign: 'center'
  },
  cardValueLarge: {
    fontSize: 48,
    fontWeight: 'bold',
    color: '#007AFF',
    marginBottom: 8,
    marginTop: 8,
    textAlign: 'center'
  },
  divider: { 
    height: 1, 
    backgroundColor: '#e0e0e0', 
    width: '100%', 
    marginVertical: 8 
  },
  totalAmountLabel: {
    fontSize: 14,
    color: '#666',
    fontWeight: '600',
    marginBottom: 4
  },
  totalAmountValue: {
    fontSize: 28,
    color: '#28a745',
    fontWeight: 'bold'
  },
  splitContainer: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20
  },
  paymentCard: {
    flex: 1,
    padding: 20,
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3
  },
  qrphCard: {
    backgroundColor: '#e3f2fd'
  },
  cashCard: {
    backgroundColor: '#fff3cd'
  },
  paymentIcon: {
    fontSize: 36,
    marginBottom: 8
  },
  paymentLabel: {
    fontSize: 13,
    color: '#666',
    fontWeight: '600',
    textTransform: 'uppercase',
    marginBottom: 4
  },
  paymentCount: {
    fontSize: 16,
    color: '#333',
    fontWeight: 'bold',
    marginBottom: 12
  },
  amountContainer: {
    marginBottom: 12
  },
  paymentAmount: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#333'
  },
  badge: {
    backgroundColor: '#28a745',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12
  },
  badgeWarning: {
    backgroundColor: '#fd7e14',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12
  },
  badgeText: {
    color: 'white',
    fontSize: 10,
    fontWeight: 'bold',
    letterSpacing: 0.5
  },
  settlementCard: {
    backgroundColor: 'white',
    padding: 20,
    borderRadius: 16,
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3
  },
  settlementTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 24,
    textAlign: 'center'
  },
  settlementRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16
  },
  settlementLabel: {
    fontSize: 14,
    color: '#666',
    flex: 1
  },
  settlementLabelBold: {
    fontSize: 16,
    color: '#333',
    fontWeight: 'bold',
    flex: 1
  },
  settlementValueGreen: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#28a745'
  },
  settlementValueOrange: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#fd7e14'
  },
  settlementValueBold: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#007AFF'
  },
  infoBox: {
    backgroundColor: '#e8f4f8',
    padding: 16,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderLeftWidth: 4,
    borderLeftColor: '#17a2b8'
  },
  infoIcon: {
    fontSize: 24,
    marginRight: 12
  },
  infoTextContainer: {
    flex: 1
  },
  infoTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8
  },
  infoText: {
    fontSize: 13,
    color: '#555',
    lineHeight: 20,
    marginBottom: 4
  }
});
