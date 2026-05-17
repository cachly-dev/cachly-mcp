/**
 * Trip reminder notifications.
 * Schedules a local push 24 hours before trip start_date.
 * Requires expo-notifications (added to app.config plugins).
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function requestNotificationPermission(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === "granted") return true;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

export async function scheduleTripReminder(tripId: string, tripName: string, startDate: string): Promise<void> {
  const granted = await requestNotificationPermission();
  if (!granted) return;

  const start = new Date(startDate);
  const reminderTime = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  if (reminderTime <= new Date()) return;

  // Cancel existing reminder for this trip before re-scheduling
  await cancelTripReminder(tripId);

  await Notifications.scheduleNotificationAsync({
    identifier: `trip-${tripId}`,
    content: {
      title: `✈️ Morgen geht's los!`,
      body: `${tripName} startet morgen. Alles gepackt?`,
      data: { tripId },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: reminderTime,
    },
  });
}

export async function cancelTripReminder(tripId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(`trip-${tripId}`).catch(() => {});
}

export async function scheduleAllTripReminders(trips: { id: string; name: string; start_date: string | null }[]): Promise<void> {
  for (const trip of trips) {
    if (trip.start_date) {
      await scheduleTripReminder(trip.id, trip.name, trip.start_date);
    }
  }
}
