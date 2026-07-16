// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "DobiusComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "DobiusComputerUseMacOSCore",
            targets: ["DobiusComputerUseMacOSCore"]
        ),
        .executable(
            name: "dobius-computer-use-macos",
            targets: ["DobiusComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "DobiusComputerUseMacOSCore",
            path: "Sources/DobiusComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "DobiusComputerUseMacOS",
            dependencies: ["DobiusComputerUseMacOSCore"],
            path: "Sources/DobiusComputerUseMacOS"
        ),
        .testTarget(
            name: "DobiusComputerUseMacOSTests",
            dependencies: ["DobiusComputerUseMacOSCore"],
            path: "Tests/DobiusComputerUseMacOSTests"
        )
    ]
)
