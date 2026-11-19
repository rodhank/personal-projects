# דור קנה — אתר תיק עבודות

כתובת: https://rodhank.github.io/personal-projects/dorkane/

## איך מוסיפים עבודה
1. מעלים את הסרטון ל-Google Drive ומשתפים אותו: "כל מי שיש לו את הקישור" (Anyone with the link).
2. מעתיקים את הקישור. ה-id הוא החלק שאחרי `/file/d/` ולפני `/view`.
3. פותחים את `data.js` ב-GitHub (כפתור העיפרון), ומוסיפים שורה:
   - עבודת TouchDesigner (בתוך `"td": [`):
     `{"t": "שם העבודה", "id": "ה-id מהדרייב", "tag": "td", "sel": true},`
     - `"sel": true` = מופיע ב"נבחרות". `"tag"`: `td` / `sound` / `abstract`.
   - סרט (בתוך `"films": [`):
     `{"t": "שם הסרט", "id": "ה-id מהדרייב", "kind": "film"},`  (`"short"` = קצרים וניסויים)
4. Commit — האתר מתעדכן תוך דקה.

הסדר באתר = הסדר בקובץ. כדי להחליף את השואוקייס: להחליף את `media/showcase.mp4` (וידאו) ו-`media/hero.mp4` (הרקע השקט).
