import { useState, type ReactNode } from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Checkbox, PanelSearch } from "@termix-ssh/plugin-sdk/ui";
import {
  folderGroups,
  groupState,
  hostMatches,
  tagGroups,
  toggleHosts,
  type TargetGroup,
  type TargetHost,
} from "./targets";

function TargetRow({
  label,
  detail,
  hostIds,
  selected,
  depth = 0,
  onChange,
}: {
  label: string;
  detail: string;
  hostIds: number[];
  selected: Set<number>;
  depth?: number;
  onChange: (next: Set<number>) => void;
}) {
  return (
    <label
      className="flex cursor-pointer items-center gap-2 py-1 pr-3 text-xs hover:bg-muted/50"
      style={{ paddingLeft: `${12 + depth * 12}px` }}
    >
      <Checkbox
        aria-label={label}
        checked={groupState(selected, hostIds)}
        disabled={!hostIds.length}
        onCheckedChange={(value) =>
          onChange(toggleHosts(selected, hostIds, value === true))
        }
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {detail}
      </span>
    </label>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border py-1.5">
      <h3 className="px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The hosts a Cluster Ops message runs against. Fleets are null while the
 * fleets plugin is not available, which hides their section.
 */
export function TargetSelector({
  hosts,
  fleets,
  selected,
  onChange,
  className = "",
}: {
  hosts: TargetHost[];
  fleets: TargetGroup[] | null;
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const named = (group: TargetGroup) =>
    !query || group.key.toLowerCase().includes(query);

  const sections = [
    { id: "fleets", title: t("ops.fleets"), groups: fleets },
    { id: "folders", title: t("ops.folders"), groups: folderGroups(hosts) },
    { id: "tags", title: t("ops.tags"), groups: tagGroups(hosts) },
  ];
  const visibleHosts = hosts.filter((host) => hostMatches(host, query));

  return (
    <aside className={`flex min-h-0 flex-col border-border ${className}`}>
      <div className="shrink-0 border-b border-border px-3 py-2">
        <PanelSearch
          fill
          value={search}
          onChange={setSearch}
          placeholder={t("ops.searchHosts")}
        />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-[11px]">
        <span role="status" className="font-medium">
          {t("ops.selectedCount", { count: selected.size })}
        </span>
        {selected.size > 0 && (
          <button
            type="button"
            className="ml-auto text-accent-brand hover:underline"
            onClick={() => onChange(new Set())}
          >
            {t("ops.clear")}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sections.map(({ id, title, groups }) => {
          const shown = groups?.filter(named) ?? [];
          if (!shown.length) return null;
          return (
            <Section key={id} title={title}>
              {shown.map((group) => (
                <TargetRow
                  key={group.key}
                  label={group.name}
                  detail={String(group.hostIds.length)}
                  hostIds={group.hostIds}
                  depth={group.depth}
                  selected={selected}
                  onChange={onChange}
                />
              ))}
            </Section>
          );
        })}
        <Section title={t("ops.allHosts")}>
          {visibleHosts.length ? (
            visibleHosts.map((host) => (
              <TargetRow
                key={host.id}
                label={host.name}
                detail={host.ip}
                hostIds={[host.id]}
                selected={selected}
                onChange={onChange}
              />
            ))
          ) : (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {t("ops.noHosts")}
            </p>
          )}
        </Section>
      </div>
    </aside>
  );
}
