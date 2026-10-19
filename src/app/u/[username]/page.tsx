import type { Metadata } from "next";
import ProfileClient from "@/components/friends/ProfileClient";

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  return { title: username, description: "A player's openings, training and ratings, as they choose to share them." };
}

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <ProfileClient username={username} />;
}
