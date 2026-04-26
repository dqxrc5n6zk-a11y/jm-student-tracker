import { useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { BookOpen, FolderOpen, Plus, Trash2, Crosshair, FileText, Minimize2 } from "lucide-react";
import { collection, deleteDoc, doc, getDocs, orderBy, query, serverTimestamp, setDoc } from "firebase/firestore";
import { deleteObject, getDownloadURL, ref as storageRef, uploadBytes } from "firebase/storage";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import courseMainBg from "../assets/course-main-bg.gif";
import {
  getFirebaseFirestoreInstance,
  getFirebaseStorageInstance,
  isFirebaseConfigured,
} from "../firebase";

const COURSE_LIBRARY_META_KEY = "jmt-course-library-v1";
const COURSE_LIBRARY_DB_NAME = "jmt-course-library-db";
const COURSE_LIBRARY_STORE_NAME = "pdfs";
const COURSE_PDF_KEY_PREFIX = "pdf:";
const COURSE_PAGE_KEY_PREFIX = "pages:";
const COURSE_FOLDERS = ["Level 0", "Level 1", "Level 2", "Level 3"];
const COURSE_BACKGROUND_VIDEO_SRC = "";
const COURSE_COLLECTION_NAME = "courses";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function getCourseLibraryCloudEnabled() {
  return isFirebaseConfigured();
}

function getCoursePdfStoragePath(courseId, fileName = "briefing.pdf") {
  const safeName = String(fileName || "briefing.pdf").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `courses/${courseId}/${safeName}`;
}

function normalizeCloudCourse(docId, data = {}) {
  const createdAtValue = data.createdAt;
  const updatedAtValue = data.updatedAt;

  const createdAt =
    typeof createdAtValue?.toDate === "function"
      ? createdAtValue.toDate().toISOString()
      : String(createdAtValue || "");
  const updatedAt =
    typeof updatedAtValue?.toDate === "function"
      ? updatedAtValue.toDate().toISOString()
      : String(updatedAtValue || createdAt || "");

  return {
    id: String(docId || data.id || ""),
    title: String(data.title || "").trim(),
    folder: String(data.folder || ""),
    drillId: String(data.drillId || ""),
    sessionId: String(data.sessionId || ""),
    sessionType: String(data.sessionType || "").trim(),
    pdfFileName: String(data.pdfFileName || "").trim(),
    pdfFileSize: Number(data.pdfFileSize || 0),
    createdAt,
    updatedAt,
    storagePath: String(data.storagePath || "").trim(),
    storageUrl: String(data.storageUrl || "").trim(),
  };
}

async function fetchCloudCourses() {
  const db = getFirebaseFirestoreInstance();
  if (!db) return [];

  const courseQuery = query(collection(db, COURSE_COLLECTION_NAME), orderBy("updatedAt", "desc"));
  const snapshot = await getDocs(courseQuery);
  return snapshot.docs.map((courseDoc) => normalizeCloudCourse(courseDoc.id, courseDoc.data()));
}

async function createCloudCourse(meta, pdfFile) {
  const db = getFirebaseFirestoreInstance();
  const storage = getFirebaseStorageInstance();

  if (!db || !storage) {
    throw new Error("Firebase is not configured for shared course storage.");
  }

  const courseRef = doc(collection(db, COURSE_COLLECTION_NAME));
  const courseId = courseRef.id;
  const storagePath = getCoursePdfStoragePath(courseId, pdfFile?.name || meta.pdfFileName || "briefing.pdf");
  const storageFileRef = storageRef(storage, storagePath);

  await uploadBytes(storageFileRef, pdfFile, {
    contentType: pdfFile?.type || "application/pdf",
  });

  const storageUrl = await getDownloadURL(storageFileRef);

  await setDoc(courseRef, {
    ...meta,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    storagePath,
    storageUrl,
  });

  return {
    id: courseId,
    ...meta,
    storagePath,
    storageUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function deleteCloudCourse(course) {
  const db = getFirebaseFirestoreInstance();
  const storage = getFirebaseStorageInstance();

  if (!db || !storage) {
    throw new Error("Firebase is not configured for shared course storage.");
  }

  const targetDocId = String(course.id || "").trim();
  const targetStoragePath = String(course.storagePath || "").trim();

  if (targetStoragePath) {
    await deleteObject(storageRef(storage, targetStoragePath)).catch(() => {
      // Ignore missing storage objects so metadata can still be cleaned up.
    });
  }

  if (targetDocId) {
    await deleteDoc(doc(db, COURSE_COLLECTION_NAME, targetDocId));
  }
}

function getCourseCloudSignature(course) {
  return [
    String(course?.title || "").trim().toLowerCase(),
    String(course?.folder || "").trim().toLowerCase(),
    String(course?.pdfFileName || "").trim().toLowerCase(),
    String(course?.drillId || "").trim(),
    String(course?.sessionId || "").trim(),
  ].join("|");
}

async function migrateLocalCoursesToCloud(localCourses = [], cloudCourses = []) {
  const localOnlyCourses = Array.isArray(localCourses) ? localCourses : [];
  if (!localOnlyCourses.length) return cloudCourses;

  const existingSignatures = new Set(cloudCourses.map(getCourseCloudSignature));
  const migratedCourses = [...cloudCourses];

  for (const localCourse of localOnlyCourses) {
    const signature = getCourseCloudSignature(localCourse);
    if (existingSignatures.has(signature)) {
      continue;
    }

    const localPdf = await loadCoursePdf(localCourse.id);
    if (!localPdf) {
      continue;
    }

    const uploadFile =
      localPdf instanceof File
        ? localPdf
        : new File([localPdf], localCourse.pdfFileName || "briefing.pdf", {
            type: localPdf.type || "application/pdf",
          });

    const cloudCourse = await createCloudCourse(
      {
        title: localCourse.title,
        folder: localCourse.folder,
        drillId: String(localCourse.drillId || ""),
        sessionId: String(localCourse.sessionId || ""),
        sessionType: String(localCourse.sessionType || "").trim(),
        pdfFileName: localCourse.pdfFileName || uploadFile.name,
        pdfFileSize: Number(localCourse.pdfFileSize || uploadFile.size || 0),
      },
      uploadFile
    );

    await storeCoursePdf(cloudCourse.id, uploadFile);

    try {
      const localPageBlobs = await loadCoursePdfPages(localCourse.id);
      if (localPageBlobs.length) {
        await storeCoursePdfPages(cloudCourse.id, localPageBlobs);
      }
    } catch {
      // Ignore page cache migration failures.
    }

    migratedCourses.push(cloudCourse);
    existingSignatures.add(signature);
  }

  return migratedCourses.sort(
    (a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
  );
}

function readStoredCourseMeta() {
  try {
    const raw = localStorage.getItem(COURSE_LIBRARY_META_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStoredCourseMeta(courses) {
  try {
    localStorage.setItem(COURSE_LIBRARY_META_KEY, JSON.stringify(courses));
  } catch {
    // ignore local persistence failures
  }
}

function openCoursePdfDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(COURSE_LIBRARY_DB_NAME, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COURSE_LIBRARY_STORE_NAME)) {
        db.createObjectStore(COURSE_LIBRARY_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open course PDF storage."));
  });
}

function getCoursePdfKey(courseId) {
  return `${COURSE_PDF_KEY_PREFIX}${courseId}`;
}

function getCoursePageKey(courseId) {
  return `${COURSE_PAGE_KEY_PREFIX}${courseId}`;
}

async function putCourseStoredValue(key, value) {
  const db = await openCoursePdfDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(COURSE_LIBRARY_STORE_NAME, "readwrite");
    tx.objectStore(COURSE_LIBRARY_STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not store course asset."));
  });
}

async function getCourseStoredValue(key) {
  const db = await openCoursePdfDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(COURSE_LIBRARY_STORE_NAME, "readonly");
    const request = tx.objectStore(COURSE_LIBRARY_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Could not load course asset."));
  });
}

async function deleteCourseStoredValue(key) {
  const db = await openCoursePdfDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(COURSE_LIBRARY_STORE_NAME, "readwrite");
    tx.objectStore(COURSE_LIBRARY_STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Could not delete course asset."));
  });
}

async function storeCoursePdf(courseId, fileBlob) {
  return putCourseStoredValue(getCoursePdfKey(courseId), fileBlob);
}

async function loadCoursePdf(courseId) {
  const storedPdf = await getCourseStoredValue(getCoursePdfKey(courseId));
  if (storedPdf) {
    return storedPdf;
  }
  return getCourseStoredValue(courseId);
}

async function fetchCoursePdfFromCloud(course) {
  const storage = getFirebaseStorageInstance();
  const cloudUrl = String(course?.storageUrl || "").trim();
  const cloudPath = String(course?.storagePath || "").trim();

  if (!storage || (!cloudUrl && !cloudPath)) {
    return null;
  }

  const resolvedUrl = cloudUrl || (await getDownloadURL(storageRef(storage, cloudPath)));
  const response = await fetch(resolvedUrl);

  if (!response.ok) {
    throw new Error("Could not download that shared course PDF.");
  }

  const pdfBlob = await response.blob();
  await storeCoursePdf(course.id, pdfBlob);
  return pdfBlob;
}

async function storeCoursePdfPages(courseId, pageBlobs) {
  return putCourseStoredValue(getCoursePageKey(courseId), pageBlobs);
}

async function loadCoursePdfPages(courseId) {
  const pageBlobs = await getCourseStoredValue(getCoursePageKey(courseId));
  return Array.isArray(pageBlobs) ? pageBlobs : [];
}

async function deleteCoursePdf(courseId) {
  await Promise.allSettled([
    deleteCourseStoredValue(courseId),
    deleteCourseStoredValue(getCoursePdfKey(courseId)),
    deleteCourseStoredValue(getCoursePageKey(courseId)),
  ]);
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getTouchDistance(touches) {
  if (!touches || touches.length < 2) return 0;
  const [firstTouch, secondTouch] = touches;
  return Math.hypot(secondTouch.clientX - firstTouch.clientX, secondTouch.clientY - firstTouch.clientY);
}

function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Could not convert PDF page into an image."));
    }, type, quality);
  });
}

async function generateCoursePdfPageBlobs(pdfBlob) {
  const pdfBytes = new Uint8Array(await pdfBlob.arrayBuffer());
  const loadingTask = getDocument({ data: pdfBytes });
  const pdfDocument = await loadingTask.promise;
  const pageBlobs = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const targetWidth = 1440;
      const scale = clampNumber(targetWidth / Math.max(baseViewport.width, 1), 1.2, 2.4);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });

      if (!context) {
        throw new Error("Could not create a PDF rendering canvas.");
      }

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      await page.render({
        canvasContext: context,
        viewport,
      }).promise;

      const pageBlob = await canvasToBlob(canvas, "image/png");
      pageBlobs.push(pageBlob);
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await pdfDocument.destroy();
  }

  return pageBlobs;
}

function formatDateTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return "";
  }
}

function formatPdfSize(size) {
  const bytes = Number(size || 0);
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function panelStyle(theme) {
  return {
    background: "rgba(24,24,27,0.92)",
    border: `1px solid ${theme.border}`,
    borderRadius: 22,
    boxShadow: theme.shadow,
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
  };
}

function premiumCourseButtonStyle(isPrimary = false) {
  return {
    borderRadius: 16,
    padding: "12px 16px",
    border: `2px solid ${isPrimary ? "rgba(226,228,232,0.82)" : "rgba(226,228,232,0.72)"}`,
    background: isPrimary ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
    color: "rgba(232,235,239,0.9)",
    fontWeight: 900,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    cursor: "pointer",
    boxShadow: "0 10px 28px rgba(0,0,0,0.18), inset 0 0 0 1px rgba(255,255,255,0.08)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
  };
}

function coursePanelStyle() {
  return {
    background: "rgba(7,10,16,0.48)",
    border: "2px solid rgba(226,228,232,0.24)",
    borderRadius: 24,
    boxShadow: "0 18px 42px rgba(0,0,0,0.22), inset 0 0 0 1px rgba(255,255,255,0.06)",
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
  };
}

function courseSubtleCardStyle() {
  return {
    borderRadius: 18,
    border: "1.5px solid rgba(226,228,232,0.18)",
    background: "rgba(255,255,255,0.045)",
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.03)",
  };
}

export default function CourseLibrary({
  theme,
  drills,
  sessions = [],
  activeCourseId,
  setActiveCourseId,
  courseHomeToken,
  onUseCourse,
  message,
}) {
  const [courses, setCourses] = useState(() => readStoredCourseMeta());
  const [selectedFolder, setSelectedFolder] = useState("");
  const [selectedCourseId, setSelectedCourseId] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [showAddCourse, setShowAddCourse] = useState(false);
  const [showPdfViewer, setShowPdfViewer] = useState(false);
  const [addingCourse, setAddingCourse] = useState(false);
  const [loadingCourses, setLoadingCourses] = useState(false);
  const [loadingViewerPages, setLoadingViewerPages] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addFolder, setAddFolder] = useState(COURSE_FOLDERS[0]);
  const [addDrillId, setAddDrillId] = useState("");
  const [addSessionId, setAddSessionId] = useState("");
  const [addPdfFile, setAddPdfFile] = useState(null);
  const [courseSearch, setCourseSearch] = useState("");
  const [courseSearchOpen, setCourseSearchOpen] = useState(false);
  const [localMessage, setLocalMessage] = useState("");
  const [previewPageUrls, setPreviewPageUrls] = useState([]);
  const [pdfViewerScale, setPdfViewerScale] = useState(1);
  const [pdfViewerBaseWidth, setPdfViewerBaseWidth] = useState(0);
  const pdfViewerTouchStartYRef = useRef(null);
  const pdfViewerTouchCurrentYRef = useRef(null);
  const pdfViewerPinchDistanceRef = useRef(0);
  const pdfViewerPinchScaleRef = useRef(1);
  const pdfViewerContentRef = useRef(null);
  const courseSearchRef = useRef(null);
  const previewUrlRef = useRef("");
  const previewPageUrlsRef = useRef([]);
  const pdfViewerScaleRef = useRef(1);
  const desktopLayout = typeof window !== "undefined" ? window.innerWidth >= 1040 : true;
  const nativeLayout = Capacitor.isNativePlatform();
  const currentMessage = localMessage || message;
  const cloudCourseLibraryEnabled = getCourseLibraryCloudEnabled();

  useEffect(() => {
    writeStoredCourseMeta(courses);
  }, [courses]);

  useEffect(() => {
    let cancelled = false;

    async function loadCoursesFromCloud() {
      if (!cloudCourseLibraryEnabled) return;

      setLoadingCourses(true);

      try {
        const cloudCourses = await fetchCloudCourses();
        const migratedCourses = await migrateLocalCoursesToCloud(readStoredCourseMeta(), cloudCourses);
        if (!cancelled) {
          setCourses(migratedCourses);
        }
      } catch (error) {
        if (!cancelled) {
          setLocalMessage(error?.message || "Could not load shared courses.");
        }
      } finally {
        if (!cancelled) {
          setLoadingCourses(false);
        }
      }
    }

    loadCoursesFromCloud();

    return () => {
      cancelled = true;
    };
  }, [cloudCourseLibraryEnabled, courseHomeToken]);

  const visibleCourses = useMemo(
    () =>
      courses
        .filter((course) => course.folder === selectedFolder)
        .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)),
    [courses, selectedFolder]
  );

  const filteredCourses = useMemo(() => {
    const searchTerm = courseSearch.trim().toLowerCase();
    if (!searchTerm) return visibleCourses;
    return visibleCourses.filter((course) => {
      const drillName = drills.find((item) => String(item.DrillID) === String(course.drillId))?.DrillName || "";
      const haystack = [
        course.title,
        course.pdfFileName,
        course.sessionType,
        course.sessionId,
        drillName,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(searchTerm);
    });
  }, [courseSearch, drills, visibleCourses]);

  const selectedCourse = useMemo(
    () => courses.find((course) => course.id === selectedCourseId) || null,
    [courses, selectedCourseId]
  );

  const selectedFolderCount = useMemo(
    () => courses.filter((course) => course.folder === selectedFolder).length,
    [courses, selectedFolder]
  );

  useEffect(() => {
    if (activeCourseId) {
      setSelectedCourseId(activeCourseId);
    }
  }, [activeCourseId]);

  useEffect(() => {
    setSelectedFolder("");
    setSelectedCourseId("");
    setShowAddCourse(false);
    setShowPdfViewer(false);
    setCourseSearch("");
    setCourseSearchOpen(false);
    setAddSessionId("");
    setLocalMessage("");
  }, [courseHomeToken]);

  useEffect(() => {
    function handleDocumentPointerDown(event) {
      if (!courseSearchRef.current?.contains(event.target)) {
        setCourseSearchOpen(false);
      }
    }

    document.addEventListener("pointerdown", handleDocumentPointerDown);
    return () => document.removeEventListener("pointerdown", handleDocumentPointerDown);
  }, []);

  useEffect(() => {
    if (selectedCourse && selectedCourse.folder !== selectedFolder) {
      setSelectedFolder(selectedCourse.folder);
      return;
    }

    const stillVisible = visibleCourses.some((course) => course.id === selectedCourseId);
    if (!stillVisible) {
      const nextCourseId = visibleCourses[0]?.id || "";
      setSelectedCourseId(nextCourseId);
      if (setActiveCourseId) {
        setActiveCourseId(nextCourseId);
      }
    }
  }, [selectedCourse, selectedFolder, selectedCourseId, setActiveCourseId, visibleCourses]);

  useEffect(() => {
    let cancelled = false;
    let nextUrl = "";

    async function loadPreview() {
      if (!selectedCourseId) {
        setPreviewUrl((currentUrl) => {
          if (currentUrl) URL.revokeObjectURL(currentUrl);
          return "";
        });
        setPreviewPageUrls((currentUrls) => {
          currentUrls.forEach((url) => URL.revokeObjectURL(url));
          return [];
        });
        return;
      }

      try {
        let pdfBlob = await loadCoursePdf(selectedCourseId);
        if (!pdfBlob && selectedCourse) {
          pdfBlob = await fetchCoursePdfFromCloud(selectedCourse);
        }
        if (!pdfBlob || cancelled) return;

        nextUrl = URL.createObjectURL(pdfBlob);

        if (!cancelled) {
          setPreviewUrl((currentUrl) => {
            if (currentUrl) URL.revokeObjectURL(currentUrl);
            return nextUrl;
          });
        }
      } catch {
        if (!cancelled) {
          setPreviewUrl((currentUrl) => {
            if (currentUrl) URL.revokeObjectURL(currentUrl);
            return "";
          });
          setPreviewPageUrls((currentUrls) => {
            currentUrls.forEach((url) => URL.revokeObjectURL(url));
            return [];
          });
          setLocalMessage("Could not load that course PDF.");
        }
      }
    }

    loadPreview();

    return () => {
      cancelled = true;
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [selectedCourse, selectedCourseId]);

  useEffect(() => {
    let cancelled = false;
    let nextPageUrls = [];

    async function loadViewerPages() {
      if (!showPdfViewer || !selectedCourseId) {
        return;
      }

      setLoadingViewerPages(true);

      try {
        let pageBlobs = await loadCoursePdfPages(selectedCourseId);

        if (!pageBlobs.length) {
          let pdfBlob = await loadCoursePdf(selectedCourseId);
          if (!pdfBlob && selectedCourse) {
            pdfBlob = await fetchCoursePdfFromCloud(selectedCourse);
          }
          if (!pdfBlob || cancelled) return;

          pageBlobs = await generateCoursePdfPageBlobs(pdfBlob);
          await storeCoursePdfPages(selectedCourseId, pageBlobs);
        }

        nextPageUrls = pageBlobs.map((pageBlob) => URL.createObjectURL(pageBlob));

        if (!cancelled) {
          setPreviewPageUrls((currentUrls) => {
            currentUrls.forEach((url) => URL.revokeObjectURL(url));
            return nextPageUrls;
          });
        }
      } catch {
        if (!cancelled) {
          setPreviewPageUrls((currentUrls) => {
            currentUrls.forEach((url) => URL.revokeObjectURL(url));
            return [];
          });
          setLocalMessage("Could not prepare that course PDF.");
        }
      } finally {
        if (!cancelled) {
          setLoadingViewerPages(false);
        }
      }
    }

    loadViewerPages();

    return () => {
      cancelled = true;
      nextPageUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [selectedCourse, selectedCourseId, showPdfViewer]);

  useEffect(() => {
    previewUrlRef.current = previewUrl;
  }, [previewUrl]);

  useEffect(() => {
    previewPageUrlsRef.current = previewPageUrls;
  }, [previewPageUrls]);

  useEffect(() => {
    pdfViewerScaleRef.current = pdfViewerScale;
  }, [pdfViewerScale]);

  useEffect(() => {
    const viewerNode = pdfViewerContentRef.current;
    if (!showPdfViewer || !viewerNode) return undefined;

    function updateBaseWidth() {
      const horizontalPadding = desktopLayout ? 40 : 24;
      const measuredWidth = Math.max(280, viewerNode.clientWidth - horizontalPadding);
      setPdfViewerBaseWidth(Math.min(900, measuredWidth));
    }

    updateBaseWidth();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateBaseWidth);
      return () => window.removeEventListener("resize", updateBaseWidth);
    }

    const resizeObserver = new ResizeObserver(() => {
      updateBaseWidth();
    });

    resizeObserver.observe(viewerNode);
    return () => resizeObserver.disconnect();
  }, [desktopLayout, showPdfViewer]);

  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      previewPageUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  async function handleAddCourseSubmit(event) {
    event.preventDefault();

    if (!addTitle.trim()) {
      setLocalMessage("Add a course name first.");
      return;
    }

    if (!addDrillId) {
      setLocalMessage("Choose the drill this course should load.");
      return;
    }

    if (!addSessionId) {
      setLocalMessage("Choose the session this course should load.");
      return;
    }

    if (!addPdfFile) {
      setLocalMessage("Choose a PDF file to store in the course library.");
      return;
    }

    setAddingCourse(true);
    setLocalMessage("");

    const now = new Date().toISOString();
    const matchingSession =
      sessions.find((session) => String(session.SessionID) === String(addSessionId)) || null;
    const nextMeta = {
      title: addTitle.trim(),
      folder: addFolder,
      drillId: String(addDrillId),
      sessionId: String(addSessionId),
      sessionType: String(
        matchingSession?.SessionName ||
          matchingSession?.Name ||
          matchingSession?.SessionID ||
          ""
      ).trim(),
      pdfFileName: addPdfFile.name,
      pdfFileSize: addPdfFile.size,
    };

    try {
      let nextCourse;

      if (cloudCourseLibraryEnabled) {
        nextCourse = await createCloudCourse(nextMeta, addPdfFile);
      } else {
        const nextId = `course-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await storeCoursePdf(nextId, addPdfFile);
        nextCourse = {
          id: nextId,
          ...nextMeta,
          createdAt: now,
          updatedAt: now,
        };
      }

      await storeCoursePdf(nextCourse.id, addPdfFile);
      try {
        const pageBlobs = await generateCoursePdfPageBlobs(addPdfFile);
        await storeCoursePdfPages(nextCourse.id, pageBlobs);
      } catch {
        // Fallback to lazy page generation later if image conversion fails now.
      }

      setCourses((current) => [nextCourse, ...current]);
      setSelectedFolder(addFolder);
      setSelectedCourseId(nextCourse.id);
      if (setActiveCourseId) {
        setActiveCourseId(nextCourse.id);
      }
      setShowAddCourse(false);
      setAddTitle("");
      setAddFolder(COURSE_FOLDERS[0]);
      setAddDrillId("");
      setAddSessionId("");
      setAddPdfFile(null);
      setLocalMessage(cloudCourseLibraryEnabled ? "Course added to the shared library." : "Course added to the library.");
    } catch (error) {
      setLocalMessage(error?.message || "Could not save that PDF.");
    } finally {
      setAddingCourse(false);
    }
  }

  async function handleDeleteCourse(courseId) {
    const course = courses.find((item) => item.id === courseId);
    if (!course) return;

    if (!window.confirm(`Delete "${course.title}" from the course library?`)) {
      return;
    }

    try {
      if (cloudCourseLibraryEnabled) {
        await deleteCloudCourse(course);
      }
      await deleteCoursePdf(courseId);
      setCourses((current) => current.filter((item) => item.id !== courseId));
      if (selectedCourseId === courseId) {
        setSelectedCourseId("");
      }
      if (setActiveCourseId && activeCourseId === courseId) {
        setActiveCourseId("");
      }
      setLocalMessage(cloudCourseLibraryEnabled ? "Course deleted from the shared library." : "Course deleted.");
    } catch (error) {
      setLocalMessage(error?.message || "Could not delete that course.");
    }
  }

  function closePdfViewer() {
    setShowPdfViewer(false);
    setPdfViewerScale(1);
    setPdfViewerBaseWidth(0);
    pdfViewerPinchDistanceRef.current = 0;
    pdfViewerPinchScaleRef.current = 1;
  }

  function updatePdfViewerScale(nextScale) {
    const clampedScale = clampNumber(nextScale, 1, 3.2);
    pdfViewerScaleRef.current = clampedScale;
    setPdfViewerScale(clampedScale);
    return clampedScale;
  }

  function handlePdfViewerTouchStart(event) {
    if ((event.touches?.length || 0) > 1) {
      pdfViewerTouchStartYRef.current = null;
      pdfViewerTouchCurrentYRef.current = null;
      return;
    }

    const touch = event.touches?.[0];
    if (!touch) return;

    pdfViewerTouchStartYRef.current = touch.clientY;
    pdfViewerTouchCurrentYRef.current = touch.clientY;
  }

  function handlePdfViewerTouchMove(event) {
    if ((event.touches?.length || 0) > 1) {
      pdfViewerTouchStartYRef.current = null;
      pdfViewerTouchCurrentYRef.current = null;
      return;
    }

    const touch = event.touches?.[0];
    if (!touch) return;

    pdfViewerTouchCurrentYRef.current = touch.clientY;
  }

  function handlePdfViewerTouchEnd() {
    const startY = pdfViewerTouchStartYRef.current;
    const endY = pdfViewerTouchCurrentYRef.current;

    pdfViewerTouchStartYRef.current = null;
    pdfViewerTouchCurrentYRef.current = null;

    if (startY === null || endY === null) return;

    if (endY - startY > 90) {
      closePdfViewer();
    }
  }

  function handlePdfContentTouchStart(event) {
    if ((event.touches?.length || 0) !== 2) return;

    pdfViewerPinchDistanceRef.current = getTouchDistance(event.touches);
    pdfViewerPinchScaleRef.current = pdfViewerScaleRef.current;
  }

  function handlePdfContentTouchMove(event) {
    if ((event.touches?.length || 0) !== 2) return;

    const currentDistance = getTouchDistance(event.touches);
    if (!currentDistance || !pdfViewerPinchDistanceRef.current) return;

    event.preventDefault();
    const scaleRatio = currentDistance / pdfViewerPinchDistanceRef.current;
    updatePdfViewerScale(pdfViewerPinchScaleRef.current * scaleRatio);
  }

  function handlePdfContentTouchEnd(event) {
    if ((event.touches?.length || 0) >= 2) return;

    pdfViewerPinchDistanceRef.current = 0;
    pdfViewerPinchScaleRef.current = pdfViewerScaleRef.current;
  }

  function handlePdfPageDoubleClick() {
    const currentScale = pdfViewerScaleRef.current;
    if (currentScale < 1.4) {
      updatePdfViewerScale(1.8);
      return;
    }
    updatePdfViewerScale(1);
  }

  function openCourseFullscreen(course) {
    if (!course) return;

    setSelectedCourseId(course.id);
    if (setActiveCourseId) {
      setActiveCourseId(course.id);
    }

    if (nativeLayout) {
      setShowPdfViewer(true);
      return;
    }

    if (course.id === selectedCourseId && previewUrl) {
      window.open(previewUrl, "_blank", "noopener,noreferrer");
    }
  }

  useEffect(() => {
    const viewerNode = pdfViewerContentRef.current;
    if (!showPdfViewer || !viewerNode) return undefined;

    function onGestureStart(event) {
      event.preventDefault();
      pdfViewerPinchScaleRef.current = pdfViewerScaleRef.current;
    }

    function onGestureChange(event) {
      event.preventDefault();
      const scaleDelta = typeof event.scale === "number" ? event.scale : 1;
      updatePdfViewerScale(pdfViewerPinchScaleRef.current * scaleDelta);
    }

    function onNativeTouchStart(event) {
      if (event.touches?.length !== 2) return;
      pdfViewerPinchDistanceRef.current = getTouchDistance(event.touches);
      pdfViewerPinchScaleRef.current = pdfViewerScaleRef.current;
    }

    function onNativeTouchMove(event) {
      if (event.touches?.length !== 2) return;
      const currentDistance = getTouchDistance(event.touches);
      if (!currentDistance || !pdfViewerPinchDistanceRef.current) return;
      event.preventDefault();
      const scaleRatio = currentDistance / pdfViewerPinchDistanceRef.current;
      updatePdfViewerScale(pdfViewerPinchScaleRef.current * scaleRatio);
    }

    function onNativeTouchEnd() {
      pdfViewerPinchDistanceRef.current = 0;
      pdfViewerPinchScaleRef.current = pdfViewerScaleRef.current;
    }

    viewerNode.addEventListener("gesturestart", onGestureStart, { passive: false });
    viewerNode.addEventListener("gesturechange", onGestureChange, { passive: false });
    viewerNode.addEventListener("touchstart", onNativeTouchStart, { passive: false });
    viewerNode.addEventListener("touchmove", onNativeTouchMove, { passive: false });
    viewerNode.addEventListener("touchend", onNativeTouchEnd, { passive: false });
    viewerNode.addEventListener("touchcancel", onNativeTouchEnd, { passive: false });

    return () => {
      viewerNode.removeEventListener("gesturestart", onGestureStart);
      viewerNode.removeEventListener("gesturechange", onGestureChange);
      viewerNode.removeEventListener("touchstart", onNativeTouchStart);
      viewerNode.removeEventListener("touchmove", onNativeTouchMove);
      viewerNode.removeEventListener("touchend", onNativeTouchEnd);
      viewerNode.removeEventListener("touchcancel", onNativeTouchEnd);
    };
  }, [showPdfViewer]);

  if (!selectedFolder) {
    return (
      <div
        style={{
          position: "relative",
          minHeight: "100%",
          height: "100%",
          overflow: "hidden",
          background: `url(${courseMainBg}) center / cover no-repeat`,
        }}
      >
        {COURSE_BACKGROUND_VIDEO_SRC ? (
          <video
            autoPlay
            muted
            loop
            playsInline
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              opacity: 0.42,
            }}
          >
            <source src={COURSE_BACKGROUND_VIDEO_SRC} />
          </video>
        ) : null}

        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(180deg, rgba(4,6,12,0.18) 0%, rgba(4,6,12,0.22) 28%, rgba(0,0,0,0.36) 100%)",
          }}
        />

        <div
          style={{
            position: "relative",
            zIndex: 1,
            minHeight: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: desktopLayout ? "26px 34px" : "16px 14px",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: desktopLayout ? 1280 : 720,
            }}
          >
            <div
              style={{
                textAlign: "center",
                marginBottom: desktopLayout ? 28 : 20,
                transform: desktopLayout ? "translateY(-10px)" : "translateY(-6px)",
              }}
            >
              <div
                style={{
                  color: "rgba(238,241,245,0.9)",
                  fontSize: desktopLayout ? 34 : 22,
                  fontWeight: 900,
                  letterSpacing: desktopLayout ? 4.2 : 2.2,
                  lineHeight: 1.05,
                  textTransform: "uppercase",
                  textShadow:
                    "0 1px 0 rgba(255,255,255,0.06), 0 6px 18px rgba(0,0,0,0.42), 0 0 30px rgba(255,255,255,0.06)",
                  fontFamily:
                    '"Arial Black", "Helvetica Neue", Arial, sans-serif',
                  fontStyle: "italic",
                }}
              >
                Be Comfortable Being Uncomfortable
              </div>
              <div
                style={{
                  width: desktopLayout ? 220 : 140,
                  height: 2,
                  margin: desktopLayout ? "10px auto 0" : "8px auto 0",
                  background:
                    "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(226,228,232,0.78) 50%, rgba(255,255,255,0) 100%)",
                  boxShadow: "0 0 10px rgba(255,255,255,0.16)",
                }}
              />
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: desktopLayout ? "repeat(2, minmax(0, 1fr))" : "1fr",
                gap: desktopLayout ? 26 : 18,
                alignItems: "stretch",
              }}
            >
              {COURSE_FOLDERS.map((folder) => {
                const folderCount = courses.filter((course) => course.folder === folder).length;

                return (
                  <button
                    key={folder}
                    type="button"
                    onClick={() => setSelectedFolder(folder)}
                    style={{
                      minHeight: desktopLayout ? "calc((100vh - 190px) / 2)" : 118,
                      borderRadius: desktopLayout ? 34 : 26,
                      border: "3px solid rgba(226,228,232,0.78)",
                      background: "transparent",
                      boxShadow:
                        "inset 0 0 0 1px rgba(255,255,255,0.08), 0 18px 40px rgba(0,0,0,0.24), inset 0 80px 120px rgba(255,255,255,0.015)",
                      backdropFilter: "blur(0px)",
                      WebkitBackdropFilter: "blur(0px)",
                      overflow: "hidden",
                      textAlign: "center",
                      padding: 0,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <div
                      style={{
                        color: "rgba(224,227,231,0.86)",
                        fontSize: desktopLayout ? 68 : 42,
                        fontWeight: 900,
                        letterSpacing: desktopLayout ? 0.6 : 0.3,
                        lineHeight: 1,
                        textShadow: "0 2px 8px rgba(0,0,0,0.24)",
                      }}
                    >
                      {folder}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100%",
        height: "100%",
        background: `url(${courseMainBg}) center / cover no-repeat`,
        color: theme.text,
        padding: desktopLayout
          ? "26px 20px 20px"
          : "calc(env(safe-area-inset-top, 0px) + 20px) 12px 12px",
        overflowX: "hidden",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: desktopLayout ? "12px 4px 18px" : "16px 2px 18px",
          marginBottom: 10,
          position: "relative",
          minHeight: desktopLayout ? 58 : 64,
        }}
      >
        <div
          style={{
            fontSize: desktopLayout ? 42 : 30,
            fontWeight: 900,
            color: "rgba(240,243,247,0.96)",
            lineHeight: 1,
            textAlign: "center",
            textShadow: "0 6px 18px rgba(0,0,0,0.3)",
          }}
        >
          {selectedFolder}
        </div>
        <div
          style={{
            position: "absolute",
            right: 0,
            top: desktopLayout ? 2 : 10,
            display: "flex",
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={() => {
              setShowAddCourse(true);
              setAddFolder(selectedFolder);
            }}
            style={{
              border: "none",
              background: "transparent",
              color: "rgba(240,243,247,0.96)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 36,
              height: 36,
              padding: 0,
              cursor: "pointer",
            }}
            aria-label="Add Course PDF"
          >
            <Plus size={22} />
          </button>
        </div>
      </div>

      <div
        style={{
          ...coursePanelStyle(),
          padding: desktopLayout ? "18px" : "14px",
          display: "grid",
          gap: 14,
        }}
      >
        <div
          style={{
            display: "grid",
            gap: 12,
          }}
        >
          <div
            ref={courseSearchRef}
            style={{
              position: "relative",
              paddingRight: desktopLayout ? 0 : 18,
            }}
          >
            <input
              value={courseSearch}
              onChange={(event) => {
                setCourseSearch(event.target.value);
                setCourseSearchOpen(true);
              }}
              onFocus={() => setCourseSearchOpen(true)}
              placeholder="Search or select a course"
              style={{
                width: "100%",
                minHeight: 52,
                padding: "12px 14px",
                borderRadius: 16,
                border: "2px solid rgba(226,228,232,0.24)",
                background: "rgba(255,255,255,0.05)",
                color: "rgba(240,243,247,0.95)",
                fontSize: 16,
                fontWeight: 700,
              }}
            />
            {courseSearchOpen ? (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 8px)",
                  left: 0,
                  right: 0,
                  zIndex: 20,
                  ...courseSubtleCardStyle(),
                  background: "rgba(12,16,24,0.96)",
                  border: "2px solid rgba(226,228,232,0.24)",
                  maxHeight: 280,
                  overflowY: "auto",
                  WebkitOverflowScrolling: "touch",
                  padding: 8,
                }}
              >
                {filteredCourses.length ? (
                  filteredCourses.map((course) => (
                    <button
                      key={`search-${course.id}`}
                      type="button"
                      onClick={() => {
                        setSelectedCourseId(course.id);
                        if (setActiveCourseId) {
                          setActiveCourseId(course.id);
                        }
                        setCourseSearch(course.title);
                        setCourseSearchOpen(false);
                      }}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "12px 12px",
                        borderRadius: 12,
                        border: "none",
                        background:
                          course.id === selectedCourseId
                            ? "rgba(255,255,255,0.1)"
                            : "transparent",
                        color: "rgba(240,243,247,0.96)",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>
                        {course.title}
                      </div>
                      <div style={{ fontSize: 12, color: "rgba(219,223,229,0.7)" }}>
                        {course.sessionType || "USPSA"}
                      </div>
                    </button>
                  ))
                ) : (
                  <div
                    style={{
                      padding: "12px 12px",
                      color: "rgba(219,223,229,0.7)",
                      fontSize: 14,
                    }}
                  >
                    No courses match that search.
                  </div>
                )}
              </div>
            ) : null}
          </div>

          <div
            style={{
              display: "grid",
              gap: 12,
            }}
          >
            {filteredCourses.length ? (
              filteredCourses.map((course) => {
                const drill = drills.find((item) => String(item.DrillID) === String(course.drillId));
                const isSelected = course.id === selectedCourseId;

                return (
                  <div
                    key={course.id}
                    style={{
                      ...courseSubtleCardStyle(),
                      border: `2px solid ${isSelected ? "rgba(226,228,232,0.88)" : "rgba(226,228,232,0.34)"}`,
                      background: isSelected ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                      padding: desktopLayout ? "16px 18px 14px" : "14px 16px 12px",
                    }}
                  >
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: desktopLayout ? "minmax(0, 1fr) 140px" : "1fr",
                        gap: 14,
                        alignItems: "center",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedCourseId(course.id);
                          if (setActiveCourseId) {
                            setActiveCourseId(course.id);
                          }
                          onUseCourse?.(course);
                        }}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          margin: 0,
                          textAlign: "left",
                          color: "inherit",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ fontSize: desktopLayout ? 26 : 22, fontWeight: 900, color: "rgba(240,243,247,0.97)", marginBottom: 8 }}>
                          {course.title}
                        </div>
                        <div style={{ color: "rgba(219,223,229,0.78)", fontSize: desktopLayout ? 16 : 15, marginBottom: 10 }}>
                          {course.sessionType || sessions.find((session) => String(session.SessionID) === String(course.sessionId))?.SessionName || "Session"}
                        </div>
                      </button>

                      <button
                        type="button"
                        onClick={() => openCourseFullscreen(course)}
                        style={{
                          ...premiumCourseButtonStyle(false),
                          minHeight: 50,
                          width: "100%",
                          fontSize: 15,
                          padding: "10px 14px",
                        }}
                      >
                        <FileText size={17} />
                        View PDF
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              <div
                style={{
                  borderRadius: 18,
                  border: "2px dashed rgba(226,228,232,0.28)",
                  padding: "28px 18px",
                  color: "rgba(219,223,229,0.72)",
                  textAlign: "center",
                  lineHeight: 1.55,
                  background: "rgba(255,255,255,0.04)",
                }}
              >
                {loadingCourses
                  ? "Loading shared courses..."
                  : visibleCourses.length
                  ? "No courses match that search."
                  : `No course PDFs saved in ${selectedFolder} yet.`}
              </div>
            )}
          </div>
        </div>
      </div>

      {currentMessage ? (
        <div
          style={{
            position: "fixed",
            left: 20,
            right: 20,
            bottom: 100,
            zIndex: 90,
            pointerEvents: "none",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              ...coursePanelStyle(),
              padding: "10px 14px",
              color: "rgba(240,243,247,0.95)",
              fontWeight: 700,
              maxWidth: 760,
              textAlign: "center",
            }}
          >
            {currentMessage}
          </div>
        </div>
      ) : null}

      {showAddCourse ? (
        <div
          onClick={() => {
            setShowAddCourse(false);
            setAddPdfFile(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 120,
          }}
        >
          <form
            onSubmit={handleAddCourseSubmit}
            onClick={(event) => event.stopPropagation()}
            style={{
              ...coursePanelStyle(),
              width: "100%",
              maxWidth: 560,
              padding: 18,
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 6, color: "rgba(240,243,247,0.95)" }}>Add Course PDF</div>
            <div style={{ color: "rgba(219,223,229,0.72)", marginBottom: 14, lineHeight: 1.55 }}>
              Save a stage briefing PDF into a level folder and link it to the drill you want loaded in Timer.
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              <input
                value={addTitle}
                onChange={(event) => setAddTitle(event.target.value)}
                placeholder="Course name"
                style={{
                  width: "100%",
                  minHeight: 48,
                  padding: "12px 14px",
                  borderRadius: 14,
                  border: "2px solid rgba(226,228,232,0.28)",
                  background: "rgba(255,255,255,0.06)",
                  color: "rgba(240,243,247,0.95)",
                  fontSize: 16,
                }}
              />

              <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
                <select
                  value={addFolder}
                  onChange={(event) => setAddFolder(event.target.value)}
                  style={{
                    width: "100%",
                    minHeight: 48,
                    padding: "12px 14px",
                    borderRadius: 14,
                    border: "2px solid rgba(226,228,232,0.28)",
                    background: "rgba(255,255,255,0.06)",
                    color: "rgba(240,243,247,0.95)",
                    fontSize: 16,
                  }}
                >
                  {COURSE_FOLDERS.map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                </select>

                <select
                  value={addDrillId}
                  onChange={(event) => setAddDrillId(event.target.value)}
                  style={{
                    width: "100%",
                    minHeight: 48,
                    padding: "12px 14px",
                    borderRadius: 14,
                    border: "2px solid rgba(226,228,232,0.28)",
                    background: "rgba(255,255,255,0.06)",
                    color: "rgba(240,243,247,0.95)",
                    fontSize: 16,
                  }}
                >
                  <option value="">Assign drill</option>
                  {drills.map((drill) => (
                    <option key={drill.DrillID} value={String(drill.DrillID)}>
                      {drill.DrillName}
                    </option>
                  ))}
                </select>
              </div>

              <select
                value={addSessionId}
                onChange={(event) => setAddSessionId(event.target.value)}
                style={{
                  width: "100%",
                  minHeight: 48,
                  padding: "12px 14px",
                  borderRadius: 14,
                  border: "2px solid rgba(226,228,232,0.28)",
                  background: "rgba(255,255,255,0.06)",
                  color: "rgba(240,243,247,0.95)",
                  fontSize: 16,
                }}
              >
                <option value="">Assign session</option>
                {sessions.map((session) => (
                  <option key={session.SessionID} value={String(session.SessionID)}>
                    {session.SessionName || session.Name || session.SessionID}
                  </option>
                ))}
              </select>

              <label
                style={{
                  borderRadius: 16,
                  border: "2px dashed rgba(226,228,232,0.28)",
                  padding: 16,
                  display: "grid",
                  gap: 8,
                  color: "rgba(219,223,229,0.72)",
                  background: "rgba(255,255,255,0.06)",
                  cursor: "pointer",
                }}
              >
                <span style={{ fontWeight: 800, color: "rgba(240,243,247,0.95)" }}>Choose briefing PDF</span>
                <span>{addPdfFile ? addPdfFile.name : "Tap to pick a PDF file"}</span>
                <input
                  type="file"
                  accept="application/pdf"
                  style={{ display: "none" }}
                  onChange={(event) => setAddPdfFile(event.target.files?.[0] || null)}
                />
              </label>

              <div style={{ color: "rgba(219,223,229,0.72)", fontSize: 14 }}>
                The linked drill and chosen session will load when you tap the course card.
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
              <button
                type="button"
                onClick={() => {
                  setShowAddCourse(false);
                  setAddPdfFile(null);
                }}
                style={premiumCourseButtonStyle(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={addingCourse}
                style={{
                  ...premiumCourseButtonStyle(true),
                  cursor: addingCourse ? "default" : "pointer",
                  opacity: addingCourse ? 0.7 : 1,
                }}
              >
                {addingCourse ? "Saving..." : "Save Course"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {showPdfViewer && selectedCourseId ? (
        <div
          onClick={closePdfViewer}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.82)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 12,
            zIndex: 130,
          }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            onTouchStart={handlePdfViewerTouchStart}
            onTouchMove={handlePdfViewerTouchMove}
            onTouchEnd={handlePdfViewerTouchEnd}
            style={{
              ...coursePanelStyle(),
              width: "100%",
              height: "100%",
              maxWidth: 980,
              maxHeight: "100%",
              padding: 10,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              }}
            >
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  borderRadius: 16,
                  overflow: "hidden",
                  border: "2px solid rgba(226,228,232,0.38)",
                  background: "#000000",
                  position: "relative",
                }}
              >
                <div
                  onTouchStart={handlePdfViewerTouchStart}
                  onTouchMove={handlePdfViewerTouchMove}
                  onTouchEnd={handlePdfViewerTouchEnd}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 36,
                    zIndex: 3,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "linear-gradient(180deg, rgba(7,10,16,0.22) 0%, rgba(7,10,16,0) 100%)",
                  }}
                >
                  <div
                    style={{
                      width: 54,
                      height: 5,
                      borderRadius: 999,
                      background: "rgba(255,255,255,0.72)",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.22)",
                    }}
                  />
                </div>

                <div
                  ref={pdfViewerContentRef}
                  style={{
                    width: "100%",
                    height: "100%",
                    background: "#000000",
                    overflow: "auto",
                    WebkitOverflowScrolling: "touch",
                    overscrollBehavior: "contain",
                  }}
                >
                  {loadingViewerPages && !previewPageUrls.length ? (
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "rgba(240,243,247,0.82)",
                        fontWeight: 700,
                      }}
                    >
                      Preparing course pages…
                    </div>
                  ) : previewPageUrls.length ? (
                    <div
                      style={{
                        width: "100%",
                        display: "flex",
                        justifyContent: "center",
                        alignItems: "flex-start",
                        minHeight: "100%",
                        padding: desktopLayout ? "34px 20px 48px" : "40px 12px 32px",
                        boxSizing: "border-box",
                        touchAction: "none",
                      }}
                    >
                      <div
                        style={{
                          width: pdfViewerBaseWidth
                            ? `${Math.round(pdfViewerBaseWidth * pdfViewerScale)}px`
                            : "100%",
                          maxWidth: "none",
                          display: "grid",
                          gap: 18,
                          transition: "width 120ms ease-out",
                        }}
                      >
                        {previewPageUrls.map((pageUrl, index) => (
                          <img
                            key={`${selectedCourseId || "course-page"}-${index}`}
                            src={pageUrl}
                            alt={`${selectedCourse?.title || "Course"} page ${index + 1}`}
                            onDoubleClick={handlePdfPageDoubleClick}
                            style={{
                              width: "100%",
                              height: "auto",
                              display: "block",
                              background: "#ffffff",
                              borderRadius: 12,
                              boxShadow: "0 18px 38px rgba(0,0,0,0.32)",
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        width: "100%",
                        height: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "rgba(240,243,247,0.82)",
                        fontWeight: 700,
                      }}
                    >
                      Could not render that PDF.
                    </div>
                  )}
                </div>

                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    zIndex: 4,
                  }}
                >
                  <button
                    type="button"
                    onClick={closePdfViewer}
                    style={{
                      position: "absolute",
                      right: 12,
                      bottom: 12,
                      width: 42,
                      height: 42,
                      borderRadius: 999,
                      border: "2px solid rgba(226,228,232,0.82)",
                      background: "rgba(7,10,16,0.72)",
                      color: "rgba(240,243,247,0.96)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 10px 24px rgba(0,0,0,0.28)",
                      cursor: "pointer",
                      pointerEvents: "auto",
                    }}
                    aria-label="Minimize PDF"
                  >
                    <Minimize2 size={18} />
                  </button>
                </div>
              </div>
            </div>
          </div>
      ) : null}
    </div>
  );
}
