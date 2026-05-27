import { useEffect } from "react";
import { useRouter } from "expo-router";
import { getAccessToken } from "../lib/auth";
import { isOnboardingDone } from "./onboarding";

export default function Root() {
  const router = useRouter();
  useEffect(() => {
    Promise.all([getAccessToken(), isOnboardingDone()]).then(([token, onboarded]) => {
      if (!onboarded) router.replace("/onboarding");
      else if (token) router.replace("/(app)/trips");
      else router.replace("/(auth)/login");
    });
  }, []);
  return null;
}
