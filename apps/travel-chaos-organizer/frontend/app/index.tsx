import { useEffect } from "react";
import { useRouter } from "expo-router";
import { getAccessToken } from "../lib/auth";

export default function Root() {
  const router = useRouter();
  useEffect(() => {
    getAccessToken().then((token) => {
      router.replace(token ? "/(app)/trips" : "/(auth)/login");
    });
  }, []);
  return null;
}
