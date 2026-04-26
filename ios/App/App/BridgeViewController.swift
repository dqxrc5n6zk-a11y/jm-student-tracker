import UIKit
import Capacitor
import CapApp_SPM

class BridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginType(VideoRecorderPlugin.self)
        bridge?.registerPluginType(RunVideoPlayerPlugin.self)
    }
}
