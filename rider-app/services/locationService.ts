/**
 * Location Service
 * Handles GPS coordinate capture for delivery tracking
 */

import * as Location from 'expo-location';

export interface DeliveryLocation {
  latitude: number;
  longitude: number;
  timestamp: Date;
  accuracy?: number;
}

/**
 * Request location permissions from the user
 */
export async function requestLocationPermission(): Promise<boolean> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === 'granted';
  } catch (error) {
    console.error('Error requesting location permission:', error);
    return false;
  }
}

/**
 * Capture current GPS coordinates
 * Returns null if permission denied or location unavailable
 */
export async function captureCurrentLocation(): Promise<DeliveryLocation | null> {
  try {
    // Check if we have permission
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== 'granted') {
      const permissionGranted = await requestLocationPermission();
      if (!permissionGranted) {
        console.log('Location permission denied');
        return null;
      }
    }

    // Get current position with high accuracy
    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });

    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      timestamp: new Date(location.timestamp),
      accuracy: location.coords.accuracy || undefined,
    };
  } catch (error) {
    console.error('Error capturing location:', error);
    return null;
  }
}

/**
 * Format coordinates for display
 */
export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

/**
 * Generate Google Maps link from coordinates
 */
export function getGoogleMapsLink(latitude: number, longitude: number): string {
  return `https://www.google.com/maps?q=${latitude},${longitude}`;
}
