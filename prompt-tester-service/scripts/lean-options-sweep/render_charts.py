#!/usr/bin/env python3
"""Render the lean-options sweep aggregates into clean PNG + SVG charts.

Usage:
    ./.venv/bin/python render_charts.py <runDir>

Inputs (already produced by the TS summarizer):
    <runDir>/charts/model-summary.json
    <runDir>/charts/suite-summary.json
    <runDir>/charts/latency-distribution.json
    <runDir>/charts/score-distribution.json
    <runDir>/charts/cost-distribution.json
    <runDir>/charts/pareto-frontier.json

Outputs: PNG + SVG pairs next to those JSON files, plus `overview.png/svg`.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import matplotlib.pyplot as plt
import matplotlib as mpl
import numpy as np
import pandas as pd
import seaborn as sns
from adjustText import adjust_text
from matplotlib.lines import Line2D
from matplotlib.patches import Patch

# ── Style ─────────────────────────────────────────────────────────────────

FAMILY_COLORS = {
    "openai": "#16a34a",
    "google": "#2563eb",
    "anthropic": "#d97706",
    "meta-llama": "#9333ea",
    "mistralai": "#dc2626",
    "cohere": "#0891b2",
}
FALLBACK_COLOR = "#374151"


def family_color(family: str) -> str:
    return FAMILY_COLORS.get(family, FALLBACK_COLOR)


def configure_style() -> None:
    sns.set_theme(style="whitegrid", context="paper")
    mpl.rcParams.update(
        {
            "figure.dpi": 144,
            "savefig.dpi": 200,
            "savefig.bbox": "tight",
            "savefig.facecolor": "white",
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.edgecolor": "#334155",
            "axes.labelcolor": "#0f172a",
            "axes.titlecolor": "#0f172a",
            "axes.titleweight": "600",
            "axes.titlesize": 13,
            "axes.titlepad": 12,
            "axes.labelsize": 11,
            "axes.labelweight": "500",
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.grid": True,
            "grid.color": "#e2e8f0",
            "grid.linewidth": 0.6,
            "xtick.color": "#334155",
            "ytick.color": "#334155",
            "xtick.labelsize": 10,
            "ytick.labelsize": 10,
            "legend.fontsize": 10,
            "legend.frameon": False,
            "font.family": ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans", "sans-serif"],
        }
    )


# ── Data loading ──────────────────────────────────────────────────────────


@dataclass
class SweepData:
    run_dir: Path
    charts_dir: Path
    manifest: dict
    models: pd.DataFrame
    suites: pd.DataFrame
    latency: pd.DataFrame
    scores: pd.DataFrame
    costs: pd.DataFrame
    pareto: dict

    @property
    def run_id(self) -> str:
        return str(self.manifest.get("runId", self.run_dir.name))


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_data(run_dir: Path) -> SweepData:
    charts_dir = run_dir / "charts"
    manifest = load_json(run_dir / "manifest.json")

    models_raw = load_json(charts_dir / "model-summary.json")["models"]
    models = pd.DataFrame(models_raw)

    suites_raw = load_json(charts_dir / "suite-summary.json")["cells"]
    suites = pd.DataFrame(suites_raw)

    latency_raw = load_json(charts_dir / "latency-distribution.json")["perModel"]
    latency_rows: list[dict] = []
    for entry in latency_raw:
        for sample in entry["samples"]:
            latency_rows.append(
                {
                    "modelId": entry["modelId"],
                    "label": entry["label"],
                    "family": entry["family"],
                    "latencyMs": sample,
                }
            )
    latency = pd.DataFrame(latency_rows)

    scores_raw = load_json(charts_dir / "score-distribution.json")["perModel"]
    score_rows: list[dict] = []
    for entry in scores_raw:
        for sample in entry["samples"]:
            score_rows.append(
                {
                    "modelId": entry["modelId"],
                    "label": entry["label"],
                    "family": entry["family"],
                    "composite": sample,
                }
            )
    scores = pd.DataFrame(score_rows)

    cost_raw = load_json(charts_dir / "cost-distribution.json")["perModel"]
    cost_rows: list[dict] = []
    for entry in cost_raw:
        for sample in entry["samples"]:
            cost_rows.append(
                {
                    "modelId": entry["modelId"],
                    "label": entry["label"],
                    "family": entry["family"],
                    "costUsd": sample,
                }
            )
    costs = pd.DataFrame(cost_rows)

    pareto = load_json(charts_dir / "pareto-frontier.json")

    return SweepData(
        run_dir=run_dir,
        charts_dir=charts_dir,
        manifest=manifest,
        models=models,
        suites=suites,
        latency=latency,
        scores=scores,
        costs=costs,
        pareto=pareto,
    )


# ── Helpers ───────────────────────────────────────────────────────────────


def save(fig: plt.Figure, charts_dir: Path, stem: str) -> None:
    png = charts_dir / f"{stem}.png"
    svg = charts_dir / f"{stem}.svg"
    fig.savefig(png)
    fig.savefig(svg)
    print(f"  wrote {png.relative_to(charts_dir.parent)} (+ .svg)")


def family_legend_handles(models: pd.DataFrame) -> list[Patch]:
    families = sorted(models["modelFamily"].unique())
    return [Patch(facecolor=family_color(f), edgecolor="none", label=f) for f in families]


def scatter_with_labels(
    ax: plt.Axes,
    df: pd.DataFrame,
    x_col: str,
    y_col: str,
    label_col: str = "label",
    size_col: str | None = None,
    base_size: float = 140.0,
) -> list[plt.Text]:
    texts: list[plt.Text] = []
    for _, row in df.iterrows():
        x = row[x_col]
        y = row[y_col]
        if pd.isna(x) or pd.isna(y):
            continue
        color = family_color(row["modelFamily"])
        size = base_size
        if size_col is not None and not pd.isna(row[size_col]):
            size = base_size * max(0.4, float(row[size_col]) * 2.0)
        ax.scatter(
            x,
            y,
            s=size,
            c=color,
            edgecolors="white",
            linewidths=1.5,
            alpha=0.9,
            zorder=3,
        )
        texts.append(
            ax.text(
                x,
                y,
                row[label_col],
                fontsize=9,
                color="#0f172a",
                fontweight="500",
                zorder=4,
            )
        )
    return texts


def add_pareto_line(
    ax: plt.Axes,
    df: pd.DataFrame,
    pareto_ids: list[str],
    x_col: str,
    y_col: str,
) -> None:
    if not pareto_ids:
        return
    pf = df[df["modelId"].isin(pareto_ids)].copy()
    pf = pf.dropna(subset=[x_col, y_col]).sort_values(x_col)
    if pf.empty:
        return
    ax.plot(
        pf[x_col],
        pf[y_col],
        color="#0f172a",
        linewidth=1.2,
        linestyle="--",
        alpha=0.6,
        zorder=2,
        label="Pareto frontier",
    )


def chart_title(ax: plt.Axes, title: str, subtitle: str | None = None) -> None:
    ax.set_title(title, loc="left", pad=14, fontsize=13, fontweight="600")
    if subtitle:
        ax.text(
            0,
            1.02,
            subtitle,
            transform=ax.transAxes,
            fontsize=10,
            color="#64748b",
            ha="left",
        )


# ── Individual charts ─────────────────────────────────────────────────────


def finalize_scatter(
    ax: plt.Axes,
    texts: list[plt.Text],
    legend_df: pd.DataFrame,
    legend_loc: str,
    has_pareto: bool,
    show_legend: bool = True,
) -> None:
    adjust_text(
        texts,
        ax=ax,
        expand=(1.35, 1.6),
        force_static=(0.2, 0.3),
        arrowprops={"arrowstyle": "-", "color": "#94a3b8", "lw": 0.6, "alpha": 0.7},
    )
    if not show_legend:
        return
    handles = family_legend_handles(legend_df)
    if has_pareto:
        handles.append(
            Line2D(
                [0],
                [0],
                color="#0f172a",
                linestyle="--",
                linewidth=1.2,
                alpha=0.6,
                label="Pareto frontier",
            )
        )
    if legend_loc == "outside-right":
        ax.legend(
            handles=handles,
            loc="center left",
            bbox_to_anchor=(1.02, 0.5),
            title="Family",
            frameon=False,
        )
    else:
        ax.legend(
            handles=handles,
            loc=legend_loc,
            title="Family",
            framealpha=0.95,
            frameon=True,
        )


def render_latency_vs_score(
    data: SweepData, ax: plt.Axes | None = None, show_legend: bool = True
) -> None:
    df = data.models.copy()
    fig = None
    if ax is None:
        fig, ax = plt.subplots(figsize=(10, 6))
    texts = scatter_with_labels(ax, df, "p50LatencyMs", "avgComposite", base_size=200)
    add_pareto_line(
        ax,
        df,
        data.pareto["scoreLatency"]["frontier"],
        "p50LatencyMs",
        "avgComposite",
    )
    ax.set_xlabel("p50 latency (ms)")
    ax.set_ylabel("Avg composite score")
    chart_title(
        ax,
        "Latency vs overall score",
        "Each dot is one model across 399 cases. Up and to the left is best.",
    )
    finalize_scatter(
        ax, texts, df, legend_loc="lower right", has_pareto=True, show_legend=show_legend
    )
    if fig is not None:
        save(fig, data.charts_dir, "latency-vs-score")
        plt.close(fig)


def render_cost_vs_score(
    data: SweepData, ax: plt.Axes | None = None, show_legend: bool = True
) -> None:
    df = data.models.dropna(subset=["avgCostUsd", "avgComposite"]).copy()
    fig = None
    if ax is None:
        fig, ax = plt.subplots(figsize=(10, 6))
    texts = scatter_with_labels(ax, df, "avgCostUsd", "avgComposite", base_size=200)
    add_pareto_line(
        ax,
        df,
        data.pareto["scoreCost"]["frontier"],
        "avgCostUsd",
        "avgComposite",
    )
    ax.set_xscale("log")
    ax.set_xlabel("Avg cost per case (USD, log scale)")
    ax.set_ylabel("Avg composite score")
    chart_title(
        ax,
        "Cost vs overall score",
        "Up and to the left buys quality most efficiently.",
    )
    finalize_scatter(
        ax, texts, df, legend_loc="lower right", has_pareto=True, show_legend=show_legend
    )
    if fig is not None:
        save(fig, data.charts_dir, "cost-vs-score")
        plt.close(fig)


def render_latency_vs_cost(
    data: SweepData, ax: plt.Axes | None = None, show_legend: bool = True
) -> None:
    df = data.models.dropna(subset=["avgCostUsd", "p95LatencyMs"]).copy()
    fig = None
    if ax is None:
        fig, ax = plt.subplots(figsize=(10, 6))
    texts = scatter_with_labels(
        ax,
        df,
        "p95LatencyMs",
        "avgCostUsd",
        size_col="avgComposite",
        base_size=160,
    )
    ax.set_xlabel("p95 latency (ms)")
    ax.set_ylabel("Avg cost per case (USD, log scale)")
    ax.set_yscale("log")
    chart_title(
        ax,
        "Latency vs cost",
        "Bottom-left is cheap and fast. Dot size = composite score.",
    )
    # Dots cluster in upper-right and lower-left; place legend outside so it
    # cannot occlude either cluster.
    finalize_scatter(
        ax,
        texts,
        df,
        legend_loc="outside-right",
        has_pareto=False,
        show_legend=show_legend,
    )
    if fig is not None:
        save(fig, data.charts_dir, "latency-vs-cost")
        plt.close(fig)


def render_exact_vs_naturalness(
    data: SweepData, ax: plt.Axes | None = None, show_legend: bool = True
) -> None:
    df = data.models.dropna(subset=["exactRate", "avgNaturalness"]).copy()
    fig = None
    if ax is None:
        fig, ax = plt.subplots(figsize=(10, 6))
    texts = scatter_with_labels(ax, df, "exactRate", "avgNaturalness", base_size=200)
    ax.set_xlabel("Exact-match rate")
    ax.set_ylabel("Avg naturalness (judge)")
    chart_title(
        ax,
        "Exact-match vs naturalness",
        "Top-right models nail the script AND sound natural.",
    )
    finalize_scatter(
        ax, texts, df, legend_loc="lower right", has_pareto=False, show_legend=show_legend
    )
    if fig is not None:
        save(fig, data.charts_dir, "exact-vs-naturalness")
        plt.close(fig)


def render_suite_heatmap_score(data: SweepData, ax: plt.Axes | None = None) -> plt.Figure:
    suites = data.suites.copy()
    model_order = (
        data.models.sort_values("avgComposite", ascending=False)["modelId"].tolist()
    )
    label_map = dict(zip(data.models["modelId"], data.models["label"]))
    suites["modelLabel"] = suites["modelId"].map(label_map)
    suites["modelIdxOrder"] = suites["modelId"].map({m: i for i, m in enumerate(model_order)})
    suites = suites.sort_values("modelIdxOrder")
    pivot = suites.pivot(index="modelLabel", columns="suite", values="avgComposite")
    ordered_index = [label_map[m] for m in model_order if label_map[m] in pivot.index]
    pivot = pivot.loc[ordered_index]
    fig = None
    if ax is None:
        fig, ax = plt.subplots(figsize=(12, 6))
    sns.heatmap(
        pivot,
        ax=ax,
        cmap="RdYlGn",
        vmin=0.2,
        vmax=0.9,
        annot=True,
        fmt=".2f",
        cbar_kws={"label": "Avg composite", "shrink": 0.8},
        linewidths=0.4,
        linecolor="white",
        annot_kws={"size": 9, "weight": "500", "color": "#0f172a"},
    )
    chart_title(
        ax,
        "Score by suite",
        "Rows = models (best score first). Columns = suite. Darker green is better.",
    )
    ax.set_xlabel("")
    ax.set_ylabel("")
    plt.setp(ax.get_xticklabels(), rotation=35, ha="right")
    if fig is not None:
        save(fig, data.charts_dir, "suite-heatmap-score")
        plt.close(fig)
        return fig
    return fig


def render_suite_heatmap_latency(data: SweepData, ax: plt.Axes | None = None) -> plt.Figure:
    suites = data.suites.copy()
    model_order = (
        data.models.sort_values("avgComposite", ascending=False)["modelId"].tolist()
    )
    label_map = dict(zip(data.models["modelId"], data.models["label"]))
    suites["modelLabel"] = suites["modelId"].map(label_map)
    pivot = suites.pivot(index="modelLabel", columns="suite", values="avgLatencyMs")
    ordered_index = [label_map[m] for m in model_order if label_map[m] in pivot.index]
    pivot = pivot.loc[ordered_index]
    fig = None
    if ax is None:
        fig, ax = plt.subplots(figsize=(12, 6))
    sns.heatmap(
        pivot,
        ax=ax,
        cmap="viridis_r",
        annot=True,
        fmt=".0f",
        cbar_kws={"label": "Avg latency (ms)", "shrink": 0.8},
        linewidths=0.4,
        linecolor="white",
        annot_kws={"size": 9, "color": "white"},
    )
    chart_title(
        ax,
        "Latency by suite",
        "Avg model latency (ms) per suite. Darker is slower.",
    )
    ax.set_xlabel("")
    ax.set_ylabel("")
    plt.setp(ax.get_xticklabels(), rotation=35, ha="right")
    if fig is not None:
        save(fig, data.charts_dir, "suite-heatmap-latency")
        plt.close(fig)
        return fig
    return fig


def render_distribution_box(
    data: SweepData,
    long_df: pd.DataFrame,
    value_col: str,
    title: str,
    subtitle: str,
    ylabel: str,
    out_stem: str,
    sort_ascending: bool,
    log_y: bool = False,
    ax: plt.Axes | None = None,
) -> None:
    order = (
        long_df.groupby("label", as_index=False)[value_col]
        .median()
        .sort_values(value_col, ascending=sort_ascending)["label"]
        .tolist()
    )
    fig = None
    if ax is None:
        fig, ax = plt.subplots(figsize=(12, 6))
    family_by_label = dict(zip(long_df["label"], long_df["family"]))
    palette = {label: family_color(family_by_label[label]) for label in order}
    sns.boxplot(
        data=long_df,
        x="label",
        y=value_col,
        order=order,
        hue="label",
        palette=palette,
        ax=ax,
        fliersize=2,
        linewidth=1.1,
        legend=False,
    )
    chart_title(ax, title, subtitle)
    ax.set_xlabel("")
    ax.set_ylabel(ylabel)
    if log_y:
        ax.set_yscale("log")
    plt.setp(ax.get_xticklabels(), rotation=35, ha="right")
    if fig is not None:
        save(fig, data.charts_dir, out_stem)
        plt.close(fig)


def render_latency_box(data: SweepData, ax: plt.Axes | None = None) -> None:
    render_distribution_box(
        data,
        data.latency,
        "latencyMs",
        title="Latency distribution",
        subtitle="Box = median ± IQR across 399 cases. Sorted fastest to slowest.",
        ylabel="Latency (ms)",
        out_stem="latency-boxplot",
        sort_ascending=True,
        ax=ax,
    )


def render_score_box(data: SweepData, ax: plt.Axes | None = None) -> None:
    render_distribution_box(
        data,
        data.scores,
        "composite",
        title="Composite score distribution",
        subtitle="Box = median ± IQR across 399 cases. Sorted best to worst.",
        ylabel="Composite (0–1)",
        out_stem="score-boxplot",
        sort_ascending=False,
        ax=ax,
    )


def render_cost_box(data: SweepData, ax: plt.Axes | None = None) -> None:
    render_distribution_box(
        data,
        data.costs,
        "costUsd",
        title="Cost-per-case distribution",
        subtitle="Log Y axis. Box = median ± IQR across 399 cases. Sorted cheapest to priciest.",
        ylabel="Cost per case (USD)",
        out_stem="cost-boxplot",
        sort_ascending=True,
        log_y=True,
        ax=ax,
    )


def render_timeout_bar(data: SweepData) -> None:
    df = data.models.sort_values("timeoutRate", ascending=False).copy()
    fig, ax = plt.subplots(figsize=(10, 5))
    colors = [
        "#dc2626" if rate > 0.05 else family_color(fam)
        for rate, fam in zip(df["timeoutRate"], df["modelFamily"])
    ]
    ax.bar(df["label"], df["timeoutRate"] * 100, color=colors, edgecolor="white")
    ax.axhline(5, color="#991b1b", linewidth=1.0, linestyle="--", alpha=0.6)
    ax.text(
        len(df) - 0.5,
        5.2,
        "5% cutoff",
        color="#991b1b",
        fontsize=9,
        ha="right",
        va="bottom",
    )
    chart_title(
        ax,
        "Timeout rate by model",
        "10-second upstream timeout per call. Red bars exceed the 5% reliability cutoff.",
    )
    ax.set_ylabel("Timeout rate (%)")
    ax.set_xlabel("")
    plt.setp(ax.get_xticklabels(), rotation=35, ha="right")
    save(fig, data.charts_dir, "timeout-bar")
    plt.close(fig)


# ── Overview panel ────────────────────────────────────────────────────────


def render_overview(data: SweepData) -> None:
    fig = plt.figure(figsize=(22, 22))
    gs = fig.add_gridspec(3, 2, hspace=0.6, wspace=0.28, top=0.93, bottom=0.06)

    render_latency_vs_score(data, ax=fig.add_subplot(gs[0, 0]), show_legend=False)
    render_cost_vs_score(data, ax=fig.add_subplot(gs[0, 1]), show_legend=False)
    render_latency_vs_cost(data, ax=fig.add_subplot(gs[1, 0]), show_legend=False)
    render_suite_heatmap_score(data, ax=fig.add_subplot(gs[1, 1]))
    render_latency_box(data, ax=fig.add_subplot(gs[2, 0]))
    render_score_box(data, ax=fig.add_subplot(gs[2, 1]))

    # Single shared legend at the bottom of the figure.
    handles = family_legend_handles(data.models) + [
        Line2D(
            [0],
            [0],
            color="#0f172a",
            linestyle="--",
            linewidth=1.2,
            alpha=0.6,
            label="Pareto frontier",
        )
    ]
    fig.legend(
        handles=handles,
        loc="lower center",
        bbox_to_anchor=(0.5, 0.01),
        ncol=len(handles),
        frameon=False,
        title=None,
    )

    fig.suptitle(
        f"SignChat lean-options sweep — {data.run_id}",
        fontsize=18,
        fontweight="600",
        y=0.975,
        color="#0f172a",
    )
    fig.text(
        0.5,
        0.953,
        f"{data.manifest.get('totalCalls', '?')} calls across {data.manifest.get('totalCases', '?')} cases × {len(data.models)} models",
        ha="center",
        fontsize=12,
        color="#64748b",
    )
    save(fig, data.charts_dir, "overview")
    plt.close(fig)


# ── Entry point ───────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("run_dir", type=Path, help="Path to the sweep run directory")
    args = parser.parse_args()

    run_dir = args.run_dir.resolve()
    if not run_dir.exists():
        parser.error(f"run dir does not exist: {run_dir}")
    charts_dir = run_dir / "charts"
    if not charts_dir.exists():
        parser.error(f"expected {charts_dir} to exist")

    configure_style()
    data = load_data(run_dir)

    print(f"Rendering charts for {data.run_id} → {charts_dir}")
    render_latency_vs_score(data)
    render_cost_vs_score(data)
    render_latency_vs_cost(data)
    render_exact_vs_naturalness(data)
    render_suite_heatmap_score(data)
    render_suite_heatmap_latency(data)
    render_latency_box(data)
    render_score_box(data)
    render_cost_box(data)
    render_timeout_bar(data)
    render_overview(data)
    print("Done.")


if __name__ == "__main__":
    main()
