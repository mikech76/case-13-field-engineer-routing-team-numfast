"""Build the submission deck from the official LCT template.

The file the team uploaded (pres/lct-b03-numfast2.pptx) is structurally broken -
PowerPoint offers to repair it and then renders almost nothing. Repairing it would
propagate the corruption, so this script builds a fresh deck from
`tz/ЛЦТ2026 Шаблон презентации.pptx`, which is the design the judges expect.

Keeps the mandated block (template slides 7-11) and drops the instruction pages
(1-6), the design examples (12-29) and the resource pages (30-37). Adds content
slides on the `Содержание_1` layout for the RoadGraph / benchmark material the
mandated five slides have no room for.

Run:  python pres/build_deck.py
Out:  pres/lct-b03-numfast3.pptx
"""

import copy
import os
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER
from pptx.util import Emu, Pt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TPL = os.path.join(ROOT, "tz", "ЛЦТ2026 Шаблон презентации.pptx")
OUT = os.path.join(ROOT, "pres", "lct-b03-numfast3.pptx")

TEAM = "NumFast"


# --------------------------------------------------------------------------- #
def drop(prs, keep_idx):
    """Keep only the slides whose 0-based index is in keep_idx, in order."""
    xml_slides = prs.slides._sldIdLst
    slides = list(xml_slides)
    for i, sld in enumerate(slides):
        if i in keep_idx:
            continue
        rId = sld.get(
            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        )
        prs.part.drop_rel(rId)
        xml_slides.remove(sld)


def settext(shape, text, size=None, bold=None, color=None):
    if shape is None:
        return  # a by_text target can vanish once we overwrite that shape
    tf = shape.text_frame
    tf.clear()
    lines = text.split("\n")
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = line
        if size:
            for r in p.runs:
                r.font.size = Pt(size)
        if bold is not None:
            for r in p.runs:
                r.font.bold = bold
        if color is not None:
            from pptx.dml.color import RGBColor

            for r in p.runs:
                r.font.color.rgb = RGBColor(*color)
    return shape


def by_idx(slide, idx):
    for sh in slide.shapes:
        if sh.is_placeholder and sh.placeholder_format.idx == idx:
            return sh
    return None


def by_text(slide, needle):
    for sh in slide.shapes:
        if sh.has_text_frame and needle in sh.text_frame.text:
            return sh
    return None


def nuke(shape):
    if shape is not None:
        shape._element.getparent().remove(shape._element)


# --------------------------------------------------------------------------- #
def build():
    prs = Presentation(TPL)
    s = prs.slides

    # ---- 1. title ---------------------------------------------------------- #
    t = s[6]   # template slide 7, title
    # idx 11 is the template's own dark hint box in the top-left corner; filling
    # it put the subtitle on a dark panel where it was unreadable. The subtitle
    # goes under the title instead, and the hint box is emptied.
    settext(by_idx(t, 0), TEAM + "\nСчётчик маршрутов RoadGraph для диспетчера выездных инженеров",
            size=20)
    for r in by_idx(t, 0).text_frame.paragraphs[1].runs:
        r.font.size = Pt(15)
        from pptx.dml.color import RGBColor

        r.font.color.rgb = RGBColor(0xFF, 0xD6, 0xE4)
    for r in by_idx(t, 0).text_frame.paragraphs[0].runs:
        from pptx.dml.color import RGBColor

        r.font.size = Pt(40)
    ph11 = by_idx(t, 11)
    if ph11 is not None:
        ph11.text_frame.clear()
    ph12 = by_idx(t, 12)
    if ph12 is not None:
        settext(ph12, "Задача 3 · Билайн Бизнес · ЛЦТ 2026")

    # ---- 2. short description + uniqueness --------------------------------- #
    d = s[7]   # template slide 8, short description
    settext(by_text(d, "Краткое описание решения:"),
            "Краткое описание решения:", bold=True)
    settext(by_text(d, "Что делает ваше решение уникальным"),
            "Лабораторный стенд диспетчера: самописный счётчик маршрутов RoadGraph "
            "и распределение заявок по бригадам считаются прямо в браузере. "
            "Ни OSRM, ни OR-Tools, ни бэкенда — только своя библиотека numfast "
            "и квантованная карта Центрального федерального округа.")
    settext(by_text(d, "В чем суть вашего решения"),
            "Свой граф дорог ЦФО: 9 056 213 узлов и 18 642 179 ориентированных "
            "рёбер, сведённых до плоского портального графа на 241 348 вершин "
            "и 1 035 952 ребра — он весит 24 МБ вместо 317 МБ и целиком грузится "
            "в браузер. Один поиск кратчайшего пути на источник заменяет HTTP-запрос "
            "на каждую пару точек. Сверху — детерминированное распределение S0 "
            "(narrow-first → вставка → 2-opt → вытеснение аварий).")
    settext(by_text(d, "Капитан: ФИО"),
            "Капитан: Чечин Михаил Иванович, веб-разработка и Data Science\n"
            "Кол-во участников: 2 человека\n"
            "Краткое описание: команда из двух человек, собственный счётчик "
            "маршрутов на собственной библиотеке numfast.")

    # ---- 3. team ----------------------------------------------------------- #
    m = s[8]   # template slide 9, team cards
    settext(by_idx(m, 0), "КОМАНДА «%s»" % TEAM)
    data = [("Чечин Михаил Иванович", "Капитан · веб-разработка, моделирование, "
             "машинное обучение, многопоточность, Data Science · Томск",
             os.path.join(ROOT, "tz", "team", "чечин.png")),
            ("Юнков Александр Сергеевич", "Геймдизайн, дизайн интерфейсов и "
             "презентации · Дедовск",
             os.path.join(ROOT, "tz", "team", "юнков.png"))]

    # The layout ships five identical cards and the team is two people. Cards
    # are addressed BY GEOMETRY, not by placeholder order: the template stores
    # the cards of column 1 after the cards of column 2, so shape order does
    # not follow the visual order. Every card is the rounded panel at top
    # 1522006 / width 2192713; its photo, name and role box sit 235318 EMU to
    # the right of the panel's left edge, and the pitch between cards is
    # 2305318. Column i is the panel left edge closest to a shape's left edge.
    CARD_TOP, CARD_W, CARD_H = 1522006, 2192713, 4834352
    AREA_L, AREA_R = 346076, 11760062      # where the five cards spanned
    cols = sorted(sh.left for sh in m.shapes
                  if sh.shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE
                  and (sh.top or 0) == CARD_TOP and (sh.width or 0) == CARD_W)
    pitch = cols[1] - cols[0]
    span = len(data) * CARD_W + (len(data) - 1) * pitch
    first_left = AREA_L + (AREA_R - AREA_L - span) // 2   # re-centre the pair
    keep_left = {c: first_left + i * pitch for i, c in enumerate(cols[:len(data)])}

    def column_of(sh):
        """Left edge of the card column *sh* belongs to, None if it belongs to none."""
        left = sh.left or 0
        near = min(cols, key=lambda c: abs(c - left))
        return near if abs(near - left) < 400000 else None

    for sh in list(m.shapes):
        if not CARD_TOP <= (sh.top or 0) < CARD_TOP + CARD_H:
            continue        # title, banner, slide number
        col = column_of(sh)
        if col is None:
            continue
        if col in keep_left:
            sh.left = sh.left + keep_left[col] - col
        else:
            nuke(sh)         # the three cards of people who are not on the team

    # name boxes (top 3622118), role boxes (top 4250028) and photo placeholders
    def row(top):
        return sorted((sh for sh in m.shapes if (sh.top or 0) == top),
                      key=lambda sh: sh.left)

    for i, sh in enumerate(row(3622118)):
        settext(sh, data[i][0], bold=True)
    for i, sh in enumerate(row(4250028)):
        settext(sh, data[i][1], size=11)
    pics = sorted((sh for sh in m.shapes
                   if sh.is_placeholder
                   and sh.placeholder_format.type == PP_PLACEHOLDER.PICTURE),
                  key=lambda sh: sh.left)
    for i, ph in enumerate(pics):
        path = data[i][2]
        if not os.path.exists(path):
            continue
        left, top, width, height = ph.left, ph.top, ph.width, ph.height
        # insert_picture crops the photo to fill the box, but the replacement
        # p:pic carries no a:xfrm (it expects a layout placeholder to inherit
        # from, and this layout has none), so the geometry is put back by hand.
        pic = ph.insert_picture(path)
        pic.left, pic.top, pic.width, pic.height = left, top, width, height

    # ---- 4. story ---------------------------------------------------------- #
    st = s[9]  # template slide 10, story
    settext(by_text(st, "Краткая история команды:"), "Краткая история команды:",
            bold=True)
    ph = by_idx(st, 27)
    if ph is not None:
        settext(ph,
                "Мы пришли из задач, где упирались в два чужих ограничения: "
                "внешний сервис маршрутов и готовый решатель. Здесь оба "
                "ограничения стали частью задачи.", size=12)
    # rows 02 and 03: the template keeps its prompt text in the header and the
    # answer area below it. Anything longer than two lines in the 01 box spills
    # over rows 02/03, so each answer goes into its own row.
    for _t, _y, _txt in (
        ("Что вас вдохновило", 3429000,
         "Своей дорогой: свой счётчик маршрутов вместо внешнего сервиса."),
        ("Расскажите о самых", 5139255,
         "Дорога, а не распределение: 65 % запросов времени не имели ответа, "
         "и виноват был формат карты, а не данные."),
    ):
        for _sh in st.shapes:
            if _sh.has_text_frame and (_sh.top or 0) == _y:
                settext(_sh, _txt, size=12)
                break
    for lab, txt in (

        ("С какими основными сложностями",
         "С какими основными сложностями или вызовами вы столкнулись и как их преодолели?"),
        ("Что вас вдохновило",
         "Что вас вдохновило или заинтересовало в этой проблеме?"),
        ("Почему вы выбрали",
         "Почему вы выбрали именно эту задачу из предложенных на хакатоне?"),
    ):
        settext(by_text(st, lab), txt, bold=True)

    # ---- 5. short about the solution --------------------------------------- #
    a = s[10]  # template slide 11, short about solution
    for i, txt in (
        (38, "Счётчик маршрутов RoadGraph и распределение S0 выполняются в "
             "браузере: загрузка квантованной карты 0,4 с, 132 поиска "
             "кратчайшего пути за 8,2 с, само распределение 34 мс. Один "
             "собранный WASM-модуль numfast-native на 196 КБ работает и в "
             "Python, и в Node.js, и в браузере."),
        (42, "Развитие: привязка растрового слоя пробок к рёбрам OSM вместо "
             "равномерного коэффициента по часу, собственные веса для пешеходов, "
             "транзитные перегоны между остановками, суточный пересчёт остатка "
             "смены при потере бригады."),
        (49, "Техническая суть решения"),
        (51, "Маркетинговая суть решения"),
        (0, "КОРОТКО О РЕШЕНИИ"),
    ):
        ph = by_idx(a, i)
        if ph is not None:
            settext(ph, txt)

    # ---- 6..10 content slides ---------------------------------------------- #
    L = None
    for lay in prs.slide_layouts:
        if lay.name == "Содержание_1":
            L = lay
    EXTRA = [
        ("RoadGraph: как устроен счётчик маршрутов", [
            "Полный граф Центрального федерального округа: 9 056 213 узлов, "
            "18 642 179 ориентированных рёбер, bbox lon 30,64…47,52 / lat 49,46…59,44.",
            "Уровень 1 — мульти-источниковый Вороной: 96 144 кластера и 265 522 "
            "порта. Кластер стягивается в точки входа и выхода.",
            "Квантованная карта: исходный формат QuantFull хранит время с шагом "
            "100 мс и радиусом 3 600 с. В поставляемый бандл квантование снято — "
            "веса в точных миллисекундах (step_ms = 1).",
            "Плоский развёрнутый портальный граф: 241 348 вершин, 1 035 952 ребра, "
            "24 МБ вместо 317 МБ полного CSR. Два семейства рёбер: портал "
            "pf→pt (один реальный отрезок OSM) и внутрикластерные ent[k]→ext[j].",
            "Мы сняли ограничение [:8] на входы и выходы: 705 102 → 817 018 ячеек, "
            "770 430 пригодных. Граф вырос на 10 % рёбер, а доля точных времён — "
            "с 35 % до 98,9 %.",
        ]),
        ("Сравнение с конкурентами", [
            "team-63 BroCode (20 страниц): Google OR-Tools VRPTW + OSRM + FastAPI, "
            "лимит поиска 10 секунд. Сравнивают свой план с базовым планом по ТЗ.",
            "team-13 Mortalith (11 слайдов): OSRM-матрица, покрытие 94,6 %, соло.",
            "Мы: OR-Tools не используем. Распределение — своё, детерминированное. "
            "Маршруты — свои, из собственного графа.",
            "Сравнение с OR-Tools на одной и той же задаче (197 заявок): "
            "179 выполненных и 580,0 км за 0,10 с против 178 и 803,9…816,1 км "
            "за 3 × 5…120 с.",
            "Что это даёт: расчёт не упирается в сеть. Один поиск на источник "
            "вместо HTTP-запроса на каждую пару.",
        ]),
        ("Скорость на массовых маршрутах", [
            "Один поиск кратчайшего пути: 1,536 мс в Node.js на WASM, 58 мс в "
            "браузере на JS.",
            "130 источников — 8,2 с; 1 000 заявок — около 2 с на том же "
            "браузерном пути.",
            "Загрузка квантованной карты в память: 0,4 с (24 МБ, 15 бинарных файлов).",
            "Само распределение: 34 мс на 100 заявок, 0 нарушений окон и смен.",
            "Для сравнения: OSRM — сетевой запрос на каждую пару; OR-Tools — "
            "3 × 5…120 с на ту же задачу.",
        ]),
        ("Результаты стенда и честные ограничения", [
            "97 из 100 заявок выполнено, 24 бригады, 323,6 км по дорогам, "
            "0 нарушений окон и смен.",
            "98,9 % запросов времени посчитаны точно; 422 без ответа показаны "
            "отдельным счётчиком, а не заменены заглушкой.",
            "Все 177 точек привязаны к дорожной сети: медиана отклонения 62 м.",
            "Точность портального графа против точной Дейкстры на полном CSR: "
            "медиана +0,6 %, хвост +7 %.",
            "Прототип не дописан: обработка событий водителя (выполнена / "
            "не выполнена / потеряна) и обед в кафешке ещё не сделаны. "
            "Код и замеры — в репозитории.",
        ]),
        ("Команда NumFast", [
            "Чечин Михаил Иванович — капитан. Веб-разработка, математическое "
            "моделирование, машинное обучение, многопоточное программирование, "
            "нейронные сети, проектирование баз данных, Data Science. Томск.",
            "Юнков Александр Сергеевич — геймдизайн, дизайн интерфейсов и "
            "презентации. Дедовск.",
            "Репозиторий: github.com/mikech76/case-13-field-engineer-routing-team-numfast",
            "Документация: README.md и ARCH.md в том же репозитории.",
        ]),
    ]
    for title, bullets in []:  # EXTRA disabled: add_slide does not carry the
        # layout's white-card decorations, so the added slides render empty.
        # The official template slides 7-11 already have the right design;
        # the RoadGraph / benchmark detail lives in docs/TECH_REPORT.md.
        pass
    for title, bullets in []:
        sl = prs.slides.add_slide(L)
        phs = [sh for sh in sl.placeholders]
        # Address the two-card layout BY GEOMETRY, not by placeholder order.
        # Measured on the template (EMU): the pink headings sit at top~1 476 583
        # and the white-card bodies at top~1 920 927. Picking "the first
        # non-title placeholder" used to land on the HEADING, so our text
        # inherited the pale-pink heading style and was unreadable on white.
        heads = [sh for sh in phs if sh.top is not None and 1_300_000 < sh.top < 1_750_000]
        bodies = [sh for sh in phs if sh.top is not None and sh.top > 1_800_000]
        heads.sort(key=lambda s: s.left or 0)
        bodies.sort(key=lambda s: s.left or 0)
        for sh in phs:
            if sh.placeholder_format.idx == 0:
                settext(sh, title, bold=True)
        # our own one-line headings, keeping the template's pale-pink style
        for k, sh in enumerate(heads[:2]):
            settext(sh, (title, bullets and "сравнение")[k] if k else title, size=20)
        for k, sh in enumerate(bodies[:2]):
            tf = sh.text_frame
            tf.clear()
            for i, b in enumerate(bullets[k::2] if k else bullets):
                p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                p.text = "• " + b
                for r in p.runs:
                    r.font.size = Pt(12)
                    from pptx.dml.color import RGBColor

                    r.font.color.rgb = RGBColor(0x1C, 0x1D, 0x22)
        # drop any leftover empty placeholders
        for sh in list(phs):
            if sh.has_text_frame and not sh.text_frame.text.strip() \
                    and sh.placeholder_format.idx != 0:
                nuke(sh)

    # Drop last, and only after every new slide exists: python-pptx names a new
    # slide part by max(partname)+1, so deleting first makes the new parts
    # collide with the ones still referenced -> duplicate zip entries -> the
    # "PowerPoint needs to repair" error we are trying to get rid of.
    keep = {6, 7, 8, 9, 10} | set(range(37, 37 + len(EXTRA)))
    drop(prs, keep)

    # --- readable ink on the light layouts ------------------------------------ #
    # Slides 2 and 4 sit on white / pale-lavender panels, and the template's own
    # sample copy there is pale lavender. Text typed there inherits it and is
    # unreadable. Force near-black on every run; the headings are already dark
    # purple, so this cannot make anything worse.
    from pptx.dml.color import RGBColor as _RGB
    _dark = _RGB(0x1C, 0x1D, 0x22)
    _n = 0
    for _si in (1, 3):
        for _sh in prs.slides[_si].shapes:
            if not _sh.has_text_frame:
                continue
            for _p in _sh.text_frame.paragraphs:
                for _r in _p.runs:
                    _r.font.color.rgb = _dark
                    _n += 1
    print("forced dark ink on %d runs of slides 2 and 4" % _n)

    # --- kill the template's own "fill in by hand" prompt text ---------------- #
    # "КОМАНДА «[НАЗВАНИЕ - заполнить руками]»" is placeholder PROMPT text, not
    # real text: clicking it in PowerPoint makes it vanish and the cursor will
    # not select it. Rewrite every such placeholder from here instead.
    _n = 0
    for _s in prs.slides:
        for _sh in _s.shapes:
            if not _sh.has_text_frame:
                continue
            _t = _sh.text_frame.text
            if "заполнить руками" not in _t:
                continue
            _new = _t
            if "[НАЗВАНИЕ" in _t:
                _new = 'КОМАНДА «%s»' % TEAM
            elif "[Имя Фамилия" in _t:
                _new = ""
            else:
                _new = _t.replace("[заполнить руками]", TEAM)
            settext(_sh, _new)
            _n += 1
    print("replaced %d template prompt placeholders" % _n)

    prs.save(OUT)

    # Sanity: duplicate zip entries are exactly what makes PowerPoint offer to
    # "repair" a file and then show it nearly empty - which is the state the
    # deck we were handed was in.
    import zipfile
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
    dupes = sorted({n for n in names if names.count(n) > 1})
    assert not dupes, f"duplicate zip entries (would be corrupt): {dupes[:5]}"
    print("wrote", OUT, os.path.getsize(OUT), "bytes,", len(prs.slides), "slides")


if __name__ == "__main__":
    sys.exit(build())
