import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, TouchableOpacity, Dimensions } from 'react-native';

export type ToastType = 'success' | 'info' | 'warning' | 'error';

interface ToastNotificationProps {
  visible: boolean;
  message: string;
  type?: ToastType;
  duration?: number;
  onHide: () => void;
  onPress?: () => void;
}

const { width } = Dimensions.get('window');

export default function ToastNotification({
  visible,
  message,
  type = 'info',
  duration = 4000,
  onHide,
  onPress,
}: ToastNotificationProps) {
  const translateY = useRef(new Animated.Value(-100)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      // Slide in and fade in
      Animated.parallel([
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          tension: 50,
          friction: 8,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();

      // Auto hide after duration
      const timer = setTimeout(() => {
        hideToast();
      }, duration);

      return () => clearTimeout(timer);
    }
  }, [visible]);

  const hideToast = () => {
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: -100,
        duration: 300,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onHide();
    });
  };

  const getBackgroundColor = () => {
    switch (type) {
      case 'success':
        return '#28a745';
      case 'info':
        return '#007AFF';
      case 'warning':
        return '#ffc107';
      case 'error':
        return '#dc3545';
      default:
        return '#007AFF';
    }
  };

  const getIcon = () => {
    switch (type) {
      case 'success':
        return '✓';
      case 'info':
        return 'ℹ';
      case 'warning':
        return '⚠';
      case 'error':
        return '✕';
      default:
        return 'ℹ';
    }
  };

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [{ translateY }],
          opacity,
        },
      ]}
    >
      <TouchableOpacity
        activeOpacity={onPress ? 0.8 : 1}
        onPress={onPress || hideToast}
        style={[
          styles.toast,
          { backgroundColor: getBackgroundColor() },
        ]}
      >
        <View style={styles.iconContainer}>
          <Text style={styles.icon}>{getIcon()}</Text>
        </View>
        <Text style={styles.message} numberOfLines={3}>
          {message}
        </Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 50,
    left: 20,
    right: 20,
    zIndex: 9999,
    alignItems: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    minWidth: width - 40,
    maxWidth: width - 40,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  iconContainer: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  icon: {
    fontSize: 20,
    color: '#fff',
    fontWeight: 'bold',
  },
  message: {
    flex: 1,
    fontSize: 15,
    color: '#fff',
    fontWeight: '600',
    lineHeight: 20,
  },
});
