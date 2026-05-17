"""
Export trip as PDF itinerary.
GET /api/v1/trips/{trip_id}/export/pdf
"""
from typing import Annotated
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from io import BytesIO
from app.auth.keycloak import user_id
from app.db.database import get_db

router = APIRouter(tags=["export"])


@router.get("/trips/{trip_id}/export/pdf")
async def export_trip_pdf(
    trip_id: UUID,
    uid: Annotated[str, Depends(user_id)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    trip_row = await db.execute(
        text("SELECT * FROM trips WHERE id = :id AND user_id = :uid"),
        {"id": str(trip_id), "uid": uid},
    )
    trip = trip_row.fetchone()
    if not trip:
        raise HTTPException(status_code=404, detail="Trip not found")
    trip = dict(trip._mapping)

    items_row = await db.execute(
        text("SELECT * FROM trip_items WHERE trip_id = :id ORDER BY event_at ASC NULLS LAST"),
        {"id": str(trip_id)},
    )
    items = [dict(r._mapping) for r in items_row.fetchall()]

    from app.services import telemetry
    await telemetry.track(db, uid, "pdf_export", {"trip_id": str(trip_id), "item_count": len(items)})

    pdf_bytes = _build_pdf(trip, items)
    filename = f"trip-{trip['name'].replace(' ', '_')[:40]}.pdf"
    return StreamingResponse(
        BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _build_pdf(trip: dict, items: list[dict]) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable
    from reportlab.lib.enums import TA_LEFT

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=2*cm, rightMargin=2*cm, topMargin=2*cm, bottomMargin=2*cm)
    styles = getSampleStyleSheet()

    PURPLE = colors.HexColor("#4f46e5")
    GRAY   = colors.HexColor("#666688")

    title_style = ParagraphStyle("title", parent=styles["Heading1"], textColor=PURPLE, fontSize=22, spaceAfter=4)
    sub_style   = ParagraphStyle("sub",   parent=styles["Normal"],   textColor=GRAY,   fontSize=10, spaceAfter=16)
    h3_style    = ParagraphStyle("h3",    parent=styles["Heading3"], textColor=PURPLE, fontSize=12, spaceBefore=12, spaceAfter=4)
    body_style  = ParagraphStyle("body",  parent=styles["Normal"],   fontSize=9, leading=13)
    label_style = ParagraphStyle("label", parent=styles["Normal"],   fontSize=8, textColor=GRAY)

    story = []
    story.append(Paragraph(f"✈ {trip['name']}", title_style))

    date_range = ""
    if trip.get("start_date") and trip.get("end_date"):
        date_range = f"{trip['start_date']} – {trip['end_date']}"
    elif trip.get("start_date"):
        date_range = str(trip["start_date"])
    if date_range:
        story.append(Paragraph(date_range, sub_style))
    if trip.get("description"):
        story.append(Paragraph(trip["description"], body_style))
    story.append(Spacer(1, 0.4*cm))
    story.append(HRFlowable(width="100%", color=PURPLE, thickness=1))
    story.append(Spacer(1, 0.3*cm))

    if not items:
        story.append(Paragraph("Keine Einträge vorhanden.", body_style))
    else:
        TYPE_EMOJI = {"flight": "✈", "train": "🚆", "bus": "🚌", "hotel": "🏨",
                      "rental_car": "🚗", "activity": "🎯", "transfer": "🚕",
                      "document": "📄", "other": "📌"}
        for item in items:
            emoji = TYPE_EMOJI.get(item.get("type", "other"), "📌")
            story.append(Paragraph(f"{emoji} {item.get('title', '–')}", h3_style))

            meta = []
            if item.get("event_at"):
                meta.append(["Datum/Zeit", str(item["event_at"])[:16]])
            if item.get("provider"):
                meta.append(["Anbieter", item["provider"]])
            if item.get("booking_ref"):
                meta.append(["Buchungs-Nr.", item["booking_ref"]])

            if meta:
                tbl = Table(meta, colWidths=[3.5*cm, 12*cm])
                tbl.setStyle(TableStyle([
                    ("TEXTCOLOR", (0,0), (0,-1), GRAY),
                    ("FONTSIZE",  (0,0), (-1,-1), 8),
                    ("BOTTOMPADDING", (0,0), (-1,-1), 2),
                    ("TOPPADDING",    (0,0), (-1,-1), 2),
                ]))
                story.append(tbl)
            story.append(Spacer(1, 0.2*cm))

    story.append(Spacer(1, 1*cm))
    story.append(Paragraph("Erstellt mit Travel Chaos Organizer · tco.app", label_style))

    doc.build(story)
    buf.seek(0)
    return buf.read()
