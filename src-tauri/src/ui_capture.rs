use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureViewport {
    width: f64,
    height: f64,
    device_pixel_ratio: f64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRequest {
    rect: CaptureRect,
    viewport: CaptureViewport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionCapture {
    mime_type: &'static str,
    data_url: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
pub struct CaptureError {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

fn unavailable() -> CaptureError {
    CaptureError {
        code: "ui_capture_unavailable",
        message: "WTS could not capture this region. You can continue with the selected context.",
        retryable: true,
    }
}

fn clipped_rect(request: CaptureRequest) -> Result<CaptureRect, CaptureError> {
    let rect = request.rect;
    let viewport = request.viewport;
    let invalid = || CaptureError {
        code: "ui_capture_invalid_region",
        message: "Select a visible region, then try again.",
        retryable: false,
    };
    if ![
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        viewport.width,
        viewport.height,
        viewport.device_pixel_ratio,
    ]
    .into_iter()
    .all(f64::is_finite)
        || rect.width <= 0.0
        || rect.height <= 0.0
        || viewport.width <= 0.0
        || viewport.height <= 0.0
        || viewport.width > 32_768.0
        || viewport.height > 32_768.0
        || viewport.device_pixel_ratio <= 0.0
        || viewport.device_pixel_ratio > 8.0
    {
        return Err(invalid());
    }
    let right = rect.x + rect.width;
    let bottom = rect.y + rect.height;
    if !right.is_finite() || !bottom.is_finite() {
        return Err(invalid());
    }
    let x = rect.x.max(0.0);
    let y = rect.y.max(0.0);
    let width = right.min(viewport.width) - x;
    let height = bottom.min(viewport.height) - y;
    if width <= 0.0 || height <= 0.0 {
        return Err(invalid());
    }
    Ok(CaptureRect {
        x,
        y,
        width,
        height,
    })
}

#[cfg(any(target_os = "macos", test))]
fn snapshot_rect(
    rect: CaptureRect,
    viewport: CaptureViewport,
    bounds: CaptureRect,
    flipped: bool,
) -> Result<CaptureRect, CaptureError> {
    let rect = clipped_rect(CaptureRequest { rect, viewport })?;
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .into_iter()
        .all(f64::is_finite)
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || bounds.width > 32_768.0
        || bounds.height > 32_768.0
    {
        return Err(unavailable());
    }
    let scale_x = bounds.width / viewport.width;
    let scale_y = bounds.height / viewport.height;
    let y = if flipped {
        rect.y
    } else {
        viewport.height - rect.y - rect.height
    };
    let mapped = CaptureRect {
        x: bounds.x + rect.x * scale_x,
        y: bounds.y + y * scale_y,
        width: rect.width * scale_x,
        height: rect.height * scale_y,
    };
    if ![mapped.x, mapped.y, mapped.width, mapped.height]
        .into_iter()
        .all(f64::is_finite)
    {
        return Err(unavailable());
    }
    Ok(mapped)
}

#[tauri::command]
pub async fn capture_ui_region(
    window: tauri::WebviewWindow,
    request: CaptureRequest,
) -> Result<RegionCapture, CaptureError> {
    let rect = clipped_rect(request)?;
    #[cfg(target_os = "macos")]
    {
        use std::{sync::mpsc, time::Duration};
        let (sender, receiver) = mpsc::channel();
        window
            .with_webview(move |platform| {
                use base64::Engine;
                use block2::RcBlock;
                use objc2::{AllocAnyThread, MainThreadMarker};
                use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
                use objc2_foundation::{NSDictionary, NSError, NSNumber, NSPoint, NSRect, NSSize};
                use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

                let Some(main_thread) = MainThreadMarker::new() else {
                    let _ = sender.send(Err(unavailable()));
                    return;
                };
                // Tauri supplies this caller's WKWebView on the main thread.
                let view: &WKWebView = unsafe { &*platform.inner().cast() };
                let bounds = view.bounds();
                let rect = match snapshot_rect(
                    rect,
                    request.viewport,
                    CaptureRect {
                        x: bounds.origin.x,
                        y: bounds.origin.y,
                        width: bounds.size.width,
                        height: bounds.size.height,
                    },
                    view.isFlipped(),
                ) {
                    Ok(rect) => rect,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        return;
                    }
                };
                let configuration = unsafe { WKSnapshotConfiguration::new(main_thread) };
                unsafe {
                    configuration.setRect(NSRect::new(
                        NSPoint::new(rect.x, rect.y),
                        NSSize::new(rect.width, rect.height),
                    ));
                    let width = rect
                        .width
                        .min(1_200.0)
                        .min(1_200.0 * rect.width / rect.height);
                    configuration.setSnapshotWidth(Some(&NSNumber::new_f64(width)));
                    configuration.setAfterScreenUpdates(true);
                }
                let callback = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let capture = (|| {
                        if !error.is_null() || image.is_null() {
                            return Err(unavailable());
                        }
                        // WebKit retains the image for the duration of this callback.
                        let image = unsafe { &*image };
                        let tiff = image.TIFFRepresentation().ok_or_else(unavailable)?;
                        let bitmap =
                            NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                                .ok_or_else(unavailable)?;
                        let width =
                            u32::try_from(bitmap.pixelsWide()).map_err(|_| unavailable())?;
                        let height =
                            u32::try_from(bitmap.pixelsHigh()).map_err(|_| unavailable())?;
                        if width == 0
                            || height == 0
                            || width > 4_096
                            || height > 4_096
                            || u64::from(width) * u64::from(height) > 8_388_608
                        {
                            return Err(unavailable());
                        }
                        // An empty property dictionary has no unchecked values.
                        let data = unsafe {
                            bitmap.representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                        }
                        .ok_or_else(unavailable)?;
                        let bytes = unsafe { data.as_bytes_unchecked() };
                        if bytes.len() > 2 * 1_024 * 1_024 {
                            return Err(unavailable());
                        }
                        Ok(RegionCapture {
                            mime_type: "image/png",
                            data_url: format!(
                                "data:image/png;base64,{}",
                                base64::engine::general_purpose::STANDARD.encode(bytes)
                            ),
                            width,
                            height,
                        })
                    })();
                    let _ = sender.send(capture);
                });
                unsafe {
                    view.takeSnapshotWithConfiguration_completionHandler(
                        Some(&configuration),
                        &callback,
                    );
                }
            })
            .map_err(|_| unavailable())?;
        tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv_timeout(Duration::from_secs(8))
                .map_err(|_| unavailable())?
        })
        .await
        .map_err(|_| unavailable())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, rect);
        Err(unavailable())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(rect: CaptureRect) -> CaptureRequest {
        CaptureRequest {
            rect,
            viewport: CaptureViewport {
                width: 1_000.0,
                height: 700.0,
                device_pixel_ratio: 2.0,
            },
        }
    }
    #[test]
    fn crops_only_the_visible_selected_region() {
        let rect = clipped_rect(request(CaptureRect {
            x: -30.0,
            y: 650.0,
            width: 120.0,
            height: 150.0,
        }))
        .unwrap();
        assert_eq!(
            rect,
            CaptureRect {
                x: 0.0,
                y: 650.0,
                width: 90.0,
                height: 50.0
            }
        );
    }
    #[test]
    fn rejects_nonfinite_and_offscreen_capture_requests() {
        for rect in [
            CaptureRect {
                x: f64::NAN,
                y: 0.0,
                width: 50.0,
                height: 50.0,
            },
            CaptureRect {
                x: 1_100.0,
                y: 0.0,
                width: 50.0,
                height: 50.0,
            },
            CaptureRect {
                x: 0.0,
                y: 0.0,
                width: -1.0,
                height: 50.0,
            },
        ] {
            assert!(clipped_rect(request(rect)).is_err());
        }
    }

    #[test]
    fn retains_an_inset_region_without_expanding_its_scope() {
        let selected = CaptureRect {
            x: 30.25,
            y: 40.5,
            width: 120.5,
            height: 80.25,
        };
        assert_eq!(clipped_rect(request(selected)).unwrap(), selected);
    }

    #[test]
    fn clips_a_region_at_each_viewport_edge() {
        let selected = CaptureRect {
            x: -30.0,
            y: -40.0,
            width: 2_000.0,
            height: 1_500.0,
        };
        assert_eq!(
            clipped_rect(request(selected)).unwrap(),
            CaptureRect {
                x: 0.0,
                y: 0.0,
                width: 1_000.0,
                height: 700.0
            }
        );
    }

    #[test]
    fn rejects_empty_infinite_and_overflowed_regions() {
        for rect in [
            CaptureRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 10.0,
            },
            CaptureRect {
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: f64::INFINITY,
            },
            CaptureRect {
                x: 0.0,
                y: f64::NEG_INFINITY,
                width: 10.0,
                height: 10.0,
            },
            CaptureRect {
                x: -100.0,
                y: 0.0,
                width: 50.0,
                height: 10.0,
            },
            CaptureRect {
                x: 0.0,
                y: 700.0,
                width: 10.0,
                height: 10.0,
            },
            CaptureRect {
                x: f64::MAX,
                y: 0.0,
                width: f64::MAX,
                height: 10.0,
            },
        ] {
            assert!(clipped_rect(request(rect)).is_err());
        }
    }

    #[test]
    fn rejects_invalid_viewports_and_pixel_ratios() {
        let selected = CaptureRect {
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        };
        for viewport in [
            CaptureViewport {
                width: 0.0,
                height: 700.0,
                device_pixel_ratio: 2.0,
            },
            CaptureViewport {
                width: 1_000.0,
                height: f64::NAN,
                device_pixel_ratio: 2.0,
            },
            CaptureViewport {
                width: 1_000.0,
                height: 700.0,
                device_pixel_ratio: 0.0,
            },
            CaptureViewport {
                width: 1_000.0,
                height: 700.0,
                device_pixel_ratio: f64::INFINITY,
            },
            CaptureViewport {
                width: 100_000.0,
                height: 700.0,
                device_pixel_ratio: 2.0,
            },
            CaptureViewport {
                width: 1_000.0,
                height: 700.0,
                device_pixel_ratio: 100.0,
            },
        ] {
            assert!(
                clipped_rect(CaptureRequest {
                    rect: selected,
                    viewport
                })
                .is_err()
            );
        }
    }

    #[test]
    fn maps_css_coordinates_to_flipped_and_unflipped_native_bounds() {
        let rect = CaptureRect {
            x: 100.0,
            y: 50.0,
            width: 200.0,
            height: 100.0,
        };
        let viewport = request(rect).viewport;
        let bounds = CaptureRect {
            x: 10.0,
            y: 20.0,
            width: 500.0,
            height: 350.0,
        };
        assert_eq!(
            snapshot_rect(rect, viewport, bounds, true).unwrap(),
            CaptureRect {
                x: 60.0,
                y: 45.0,
                width: 100.0,
                height: 50.0
            }
        );
        assert_eq!(
            snapshot_rect(rect, viewport, bounds, false).unwrap(),
            CaptureRect {
                x: 60.0,
                y: 295.0,
                width: 100.0,
                height: 50.0
            }
        );
    }

    #[test]
    fn rejects_unavailable_native_bounds() {
        let rect = CaptureRect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 100.0,
        };
        assert!(
            snapshot_rect(
                rect,
                request(rect).viewport,
                CaptureRect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0
                },
                true
            )
            .is_err()
        );
    }

    #[test]
    fn requires_a_new_selection_for_an_invalid_region() {
        let rect = CaptureRect {
            x: 0.0,
            y: 0.0,
            width: -1.0,
            height: 50.0,
        };
        let error = clipped_rect(request(rect)).unwrap_err();
        assert_eq!(error.code, "ui_capture_invalid_region");
        assert!(!error.retryable);
    }
}
