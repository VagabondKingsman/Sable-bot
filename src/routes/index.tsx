import { createFileRoute } from "@tanstack/react-router";
import { Desk } from "@/components/sable/desk";

export const Route = createFileRoute("/")({
  ssr: false,
  component: Desk,
});
