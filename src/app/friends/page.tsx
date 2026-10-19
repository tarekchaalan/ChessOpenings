import type { Metadata } from "next";
import FriendsClient from "@/components/friends/FriendsClient";

export const metadata: Metadata = {
  title: "Friends",
  description: "Follow players, see what your friends are learning, compare and challenge them.",
};

export default function FriendsPage() {
  return <FriendsClient />;
}
