export type RouterAxes = {
  targetType: string;
  intent: string;
  toolchain: string;
};

export type RouteDef = {
  label: string;
  skill: string;
  axes: RouterAxes;
  keywords: { must: string; note?: string }[];
};

export type RoutingConfig = {
  schemaVersion: number;
  meta: { fallbackId: string; notice?: string; axes?: string[] };
  priority: string[];
  routes: Record<string, RouteDef>;
};

export type RouteHit = {
  routeId: string;
  label: string;
  skill: string;
  axes: RouterAxes;
  rationale: string;
};
