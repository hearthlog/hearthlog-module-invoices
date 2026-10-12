<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import type Highcharts from 'highcharts/highstock';
    import { loadHighstock } from './highcharts-loader.js';
    import { appearance } from '@hearthlog/sdk/runtime';

    const chartFontFamily =
        "'Inter Variable', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    export interface ColumnChartSeries {
        name: string;
        data: number[];
        /** Theme token resolved at render time, e.g. `--stor-action`. */
        colorVar: string;
        /** `line` draws a comparison overlay on top of the columns. */
        type?: 'column' | 'line';
        dashStyle?: 'Solid' | 'ShortDash' | 'Dash' | 'Dot';
        opacity?: number;
    }

    let {
        categories = [],
        series = [],
        stacked = false,
        height = 280,
        ariaLabel,
        formatValue,
        emptyMessage = 'No data for this period.',
        markerIndex = null,
        onPointClick,
    }: {
        categories: string[];
        series: ColumnChartSeries[];
        stacked?: boolean;
        height?: number;
        ariaLabel: string;
        formatValue: (value: number) => string;
        emptyMessage?: string;
        /** Highlights one x-axis bucket, e.g. the current month. */
        markerIndex?: number | null;
        /** Receives the clicked bucket; omitted when the chart is read-only. */
        onPointClick?: (point: { seriesIndex: number; index: number; name: string }) => void;
    } = $props();

    let chartContainer = $state<HTMLElement | null>(null);
    let chart = $state<Highcharts.Chart | null>(null);
    let highcharts = $state<typeof import('highcharts/highstock') | null>(null);
    let isCreatingChart = false;

    const hasData = $derived(categories.length > 0);

    function cssColor(variable: string): string {
        return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    }

    /** Compact axis labels: 1 250 000 -> "1,3 M", 42 000 -> "42 k". */
    function axisLabel(value: number): string {
        const absolute = Math.abs(value);
        if (absolute >= 1_000_000) {
            return `${(value / 1_000_000).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} M`;
        }
        if (absolute >= 1_000) {
            return `${(value / 1_000).toLocaleString('cs-CZ', { maximumFractionDigits: 0 })} k`;
        }
        return String(Math.round(value));
    }

    function buildOptions(): Highcharts.Options {
        // Rebuild when the resolved appearance changes so a theme switch
        // repaints the chart with the new tokens.
        void appearance.resolved;
        const border = cssColor('--stor-border');
        const axis = cssColor('--stor-chart-axis');
        const surface = cssColor('--stor-surface-raised');
        const ink = cssColor('--stor-ink');
        const muted = cssColor('--stor-muted-text');
        const markerFill = cssColor('--stor-accent-soft');
        const showMarker =
            typeof markerIndex === 'number' &&
            markerIndex >= 0 &&
            markerIndex < categories.length;

        return {
            chart: {
                type: 'column',
                height,
                backgroundColor: 'transparent',
                style: { fontFamily: chartFontFamily },
                animation: false,
            },
            title: { text: undefined },
            credits: { enabled: false },
            legend: {
                enabled: series.length > 1,
                itemStyle: { color: muted, fontFamily: chartFontFamily, fontSize: '12px', fontWeight: '600' },
                itemHoverStyle: { color: ink },
                symbolRadius: 3,
                margin: 16,
            },
            xAxis: {
                categories,
                labels: { style: { fontFamily: chartFontFamily, color: axis } },
                lineColor: border,
                tickColor: border,
                plotBands: showMarker
                    ? [{
                        from: markerIndex - 0.5,
                        to: markerIndex + 0.5,
                        color: markerFill,
                        zIndex: 0,
                    }]
                    : undefined,
            },
            yAxis: {
                title: { text: undefined },
                labels: {
                    style: { fontFamily: chartFontFamily, color: axis },
                    formatter: function (this: Highcharts.AxisLabelsFormatterContextObject) {
                        return axisLabel(Number(this.value));
                    },
                },
                gridLineColor: border,
            },
            tooltip: {
                shared: true,
                backgroundColor: surface,
                borderWidth: 0,
                borderRadius: 10,
                shadow: false,
                style: { color: ink, fontFamily: chartFontFamily, fontSize: '12px' },
                formatter: function (this: Highcharts.Point) {
                    const context = this as unknown as {
                        key?: string;
                        points?: Array<{ series: { name: string }; y?: number | null }>;
                        series: { name: string };
                        y?: number | null;
                    };
                    const points = context.points ?? [context];
                    const rows = points
                        .map((point) => `${point.series.name}: <b>${formatValue(point.y ?? 0)}</b>`)
                        .join('<br/>');
                    return `<span style="font-weight:600">${context.key ?? ''}</span><br/>${rows}`;
                },
            },
            plotOptions: {
                series: { animation: false },
                column: {
                    stacking: stacked ? 'normal' : undefined,
                    borderWidth: 0,
                    groupPadding: 0.14,
                    // Grouped direction bars need a gap between them; stack
                    // segments stay tight.
                    pointPadding: stacked ? 0.06 : 0.14,
                    animation: false,
                },
            },
            accessibility: { description: ariaLabel },
            series: series.map((entry) => ({
                type: entry.type ?? ('column' as const),
                name: entry.name,
                data: [...entry.data],
                color: cssColor(entry.colorVar) || undefined,
                opacity: entry.opacity,
                dashStyle: entry.dashStyle,
                lineWidth: entry.type === 'line' ? 2 : undefined,
                marker: entry.type === 'line' ? { enabled: false } : undefined,
                // Rounded caps help the grouped direction bars read as
                // separate objects. Stack segments stay square because a zero
                // tax makes any of them the visible top of the stack.
                borderRadius: entry.type === 'line' ? undefined : stacked && series.length > 1 ? 0 : 3,
                point: onPointClick
                    ? {
                        events: {
                            click(this: Highcharts.Point) {
                                onPointClick({
                                    seriesIndex: this.series.index,
                                    index: this.index,
                                    name: String(this.category ?? ''),
                                });
                            },
                        },
                    }
                    : undefined,
            })),
        };
    }

    async function ensureHighcharts() {
        if (highcharts) return highcharts;
        highcharts = await loadHighstock();
        return highcharts;
    }

    async function createChart(): Promise<void> {
        if (!chartContainer || chart || isCreatingChart || !hasData) return;
        isCreatingChart = true;
        try {
            const library = await ensureHighcharts();
            if (!chartContainer || chart) return;
            chart = library.chart(chartContainer, buildOptions());
        } finally {
            isCreatingChart = false;
        }
    }

    onMount(() => {
        void createChart();
    });

    onDestroy(() => {
        if (chart) {
            chart.destroy();
            chart = null;
        }
    });

    $effect(() => {
        if (!hasData) {
            if (chart) {
                chart.destroy();
                chart = null;
            }
            return;
        }
        if (chart) {
            chart.update(buildOptions(), true, true);
            return;
        }
        void createChart();
    });
</script>

{#if hasData}
    <div bind:this={chartContainer} class="w-full" role="img" aria-label={ariaLabel}></div>
{:else}
    <div class="flex min-h-[12rem] items-center justify-center rounded-xl bg-[var(--stor-surface-muted)]/70 px-6 py-8 text-center text-sm text-[var(--stor-muted-text)]">
        <p>{emptyMessage}</p>
    </div>
{/if}
