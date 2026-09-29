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
    by_idx(t, 0).text_frame.text = TEAM
    for i, txt in ((11, "Счётчик маршрутов RoadGraph\nдля диспетчера выездных инженеров"),
                   (12, "Задача 3 · Билайн Бизнес · ЛЦТ 2026")):
        ph = by_idx(t, i)
        if ph is not None:
            ph.text_frame.text = txt

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
    cards = []
    for sh in m.shapes:
        if sh.has_text_frame:
            txt = sh.text_frame.text.strip()
            if txt.startswith("Имя Фамилия"):
                cards.append(sh)
    data = [("Чечин Михаил Иванович", "Капитан · веб-разработка, моделирование, "
             "машинное обучение, многопоточность, Data Science · Томск"),
            ("Юнков Александр Сергеевич", "Геймдизайн, дизайн интерфейсов и "
             "презентации · Дедовск")]
    for i, sh in enumerate(cards):
        if i < len(data):
            settext(sh, data[i][0], bold=True)
        else:
            settext(sh, "")
    # the four-line role box right under each name
    roles = [sh for sh in m.shapes
             if sh.has_text_frame and "Роль в команде" in sh.text_frame.text]
    for i, sh in enumerate(roles):
        if i < len(data):
            settext(sh, data[i][1], size=11)
        else:
            settext(sh, "")

    # ---- 4. story ---------------------------------------------------------- #
    st = s[9]  # template slide 10, story
    settext(by_text(st, "Краткая история команды:"), "Краткая история команды:",
            bold=True)
    ph = by_idx(st, 27)
    if ph is not None:
        settext(ph,
                "Мы пришли из задач, где упирались в два чужых ограничения: "
                "внешний сервис маршрутов и готовый решатель. Здесь оба ограничения "
                "стали частью задачи.\n\n"
                "Самым сложным оказалось не распределение, а дорога. Первые версии "
                "рисовали ноги прямыми, и мы обнаружили, что 65 % запросов времени "
                "между точками вообще не имеют ответа в уквантованной карте. "
                "Причина оказалась в формате, а не в данных: внутрикластерные "
                "матрицы были обрезаны до восьми входов и выходов. Мы пересчитали "
                "их по полному графу ЦФО без этого ограничения — доля точных "
                "времён выросла с 35 % до 98,9 %.\n\n"
                "Второй урок: цифра 100 из 100 оказалась ненастоящей — её "
                "держала заглушка, подставлявшая выдуманные 15 минут и 3 км. "
                "После её удаления осталось 97. Мы показываем и 97, и причины "
                "четырёх отказов.", size=12)
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
    for title, bullets in EXTRA:
        sl = prs.slides.add_slide(L)
        phs = [sh for sh in sl.placeholders]
        # title placeholder = the one with idx 0 (or the first with a short box)
        body = None
        for sh in phs:
            if sh.placeholder_format.idx == 0:
                settext(sh, title, bold=True)
            else:
                body = body or sh
        for sh in phs:
            if sh.placeholder_format.idx == 0:
                continue
            if not sh.has_text_frame:
                continue
            if body is sh:
                tf = sh.text_frame
                tf.clear()
                for i, b in enumerate(bullets):
                    p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                    p.text = "• " + b
                    for r in p.runs:
                        r.font.size = Pt(13)
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
