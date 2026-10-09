//! Native macOS notifications.
//!
//! WTS posts notifications through UNUserNotificationCenter, so the banner shows the
//! WTS icon. A click on the banner shows the WTS window and opens the screen that the
//! notification names. The old osascript path showed the Script Editor icon, and a
//! click opened Script Editor.

/// The event that the UI receives when the user clicks a notification.
pub const NOTIFICATION_OPEN_EVENT: &str = "wts://notification-open";
/// The userInfo key that holds the in-app path to open.
pub const NOTIFICATION_PATH_KEY: &str = "wtsPath";

/// Returns the in-app path to open, or None when the value is not a safe WTS path.
/// A path starts with one "/", has no scheme or host, and has no control characters.
pub fn notification_open_path(value: &str) -> Option<String> {
    let value = value.trim();
    if !value.starts_with('/')
        || value.starts_with("//")
        || value.len() > 512
        || value.contains("://")
        || value.contains('\\')
        || value.chars().any(char::is_control)
    {
        return None;
    }
    Some(value.to_owned())
}

#[cfg(target_os = "macos")]
mod native {
    use super::{notification_open_path, NOTIFICATION_OPEN_EVENT, NOTIFICATION_PATH_KEY};
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
    use objc2_foundation::{NSBundle, NSDictionary, NSError, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::sync::OnceLock;
    use tauri::{Emitter, Manager};

    /// UNUserNotificationCenter needs an app bundle with a bundle identifier.
    /// An unbundled development binary raises an Objective-C exception instead.
    pub fn native_available() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    pub struct DelegateIvars {
        app: tauri::AppHandle,
    }

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and the class does not implement Drop.
        #[unsafe(super(NSObject))]
        #[name = "WTSNotificationDelegate"]
        #[ivars = DelegateIvars]
        struct NotificationDelegate;

        unsafe impl NSObjectProtocol for NotificationDelegate {}

        unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
            // Show the banner while WTS is the front app too.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                let info = response.notification().request().content().userInfo();
                let key = NSString::from_str(NOTIFICATION_PATH_KEY);
                let path = info
                    .objectForKey(&key)
                    .and_then(|value| value.downcast::<NSString>().ok())
                    .and_then(|value| notification_open_path(&value.to_string()));
                open_from_notification(&self.ivars().app, path);
                completion_handler.call(());
            }
        }
    );

    fn open_from_notification(app: &tauri::AppHandle, path: Option<String>) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        if let Some(path) = path {
            let _ = app.emit_to("main", NOTIFICATION_OPEN_EVENT, path);
        }
    }

    struct Registered(Retained<NotificationDelegate>);
    // SAFETY: The delegate is only created once and is never mutated after creation.
    unsafe impl Send for Registered {}
    unsafe impl Sync for Registered {}
    static DELEGATE: OnceLock<Registered> = OnceLock::new();

    /// Sets the delegate and asks for permission. Call once on the main thread at startup.
    pub fn initialize(app: &tauri::AppHandle) {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let registered = DELEGATE.get_or_init(|| {
            let delegate = NotificationDelegate::alloc().set_ivars(DelegateIvars { app: app.clone() });
            // SAFETY: NSObject's init is safe for this subclass.
            Registered(unsafe { msg_send![super(delegate), init] })
        });
        center.setDelegate(Some(ProtocolObject::from_ref(&*registered.0)));
        let done = RcBlock::new(|_granted: Bool, _error: *mut NSError| {});
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &done,
        );
    }

    pub fn send(identifier: &str, title: &str, body: &str, path: Option<&str>) -> Result<(), ()> {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        if let Some(path) = path.and_then(notification_open_path) {
            let key = NSString::from_str(NOTIFICATION_PATH_KEY);
            let value = NSString::from_str(&path);
            let value_object: &AnyObject = value.as_ref();
            let typed: Retained<NSDictionary<NSString, AnyObject>> =
                NSDictionary::from_slices(&[&*key], &[value_object]);
            // SAFETY: Every NSString is an AnyObject, so the key type can widen.
            let info: Retained<NSDictionary<AnyObject, AnyObject>> =
                unsafe { Retained::cast_unchecked(typed) };
            // SAFETY: The dictionary holds only property-list values.
            unsafe { content.setUserInfo(&info) };
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(identifier),
            &content,
            None,
        );
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, None);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub use native::{initialize, native_available, send};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_paths_stay_inside_the_app() {
        assert_eq!(notification_open_path("/time"), Some("/time".to_owned()));
        assert_eq!(
            notification_open_path(" /sessions/ws_1/verification "),
            Some("/sessions/ws_1/verification".to_owned())
        );
        assert_eq!(notification_open_path("time"), None);
        assert_eq!(notification_open_path("//evil.example/x"), None);
        assert_eq!(notification_open_path("/x?u=https://evil.example"), None);
        assert_eq!(notification_open_path("https://evil.example"), None);
        assert_eq!(notification_open_path("/a\nb"), None);
        assert_eq!(notification_open_path(""), None);
    }
}
